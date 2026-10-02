import { MODULE_BY_KEY } from '@/data/modules'
import {
  allRows,
  listAttention,
  listCorrections,
  listRows,
  resetRows,
  saveRows,
  updateState,
} from '@/data/local-store'
import type {
  ActionResult,
  AttentionItem,
  CorrectionVersion,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
// 「标记」开头的动作（标记异常/标记荒废/标记过期/标记退化）都是在登记异常，必须算进去。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚', '标记']

// 改判入库动作：气象观测里「确认数据」就是把异常值改判后确认入库，目标状态在模块元数据里登记。
const CORRECT_ACTION = '确认数据'
const MARK_ABNORMAL_ACTION = '标记异常'

// 同一条记录的操作串行化：确认改判与重新标记异常并发时，只放行先到的那个，
// 后到的按冲突拒绝，保证一次并发只落一次库。
const inFlight = new Set<string>()

function acquireLock(scope: string): boolean {
  if (inFlight.has(scope)) {
    return false
  }
  inFlight.add(scope)
  return true
}

function releaseLock(scope: string): void {
  inFlight.delete(scope)
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const scope = `${key}:${id}`
  if (!acquireLock(scope)) {
    return { ok: false, message: `这条${meta.entity}有正在进行的操作，本次「${action}」未生效` }
  }
  try {
    const rows = listRows(key)
    const index = rows.findIndex((row) => Number(row.id) === id)
    if (index < 0) {
      return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
    }
    const current = String(rows[index].status)
    if (current === target) {
      return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
    }
    const lastStatus = meta.statuses[meta.statuses.length - 1]
    const updated: EntryRow = {
      ...rows[index],
      status: target,
      pending: target !== lastStatus,
      abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
    }
    const next = [...rows]
    next[index] = updated
    try {
      saveRows(key, next)
    } catch {
      return { ok: false, message: `${meta.entity}「${action}」保存失败，状态已回退，请重试` }
    }
    return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
  } finally {
    releaseLock(scope)
  }
}

export type CorrectionInput = {
  recordId: number
  field: string
  retestValue: string
  note?: string
  operator?: string
}

// 异常值改判入库：把记录从「异常值」改判为办结态，行数据、历史版本、火险监测关注事项
// 在一次原子提交里同进同退 —— 保存失败时面板、标签页和待办一起留在改判前。
export async function confirmCorrection(key: string, input: CorrectionInput): Promise<ActionResult> {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[CORRECT_ACTION]
  const abnormalStatus = meta.actionTargets[MARK_ABNORMAL_ACTION]
  if (!target || !abnormalStatus) {
    return { ok: false, message: `${meta.entity}没有登记改判入库的流转动作` }
  }
  const scope = `${key}:${input.recordId}`
  if (!acquireLock(scope)) {
    return { ok: false, message: `这条${meta.entity}有正在进行的操作，本次改判未生效` }
  }
  try {
    // 入库前让出事件循环：模拟真实落库耗时，也让并发的第二次提交能确实撞到锁上
    await new Promise((resolve) => setTimeout(resolve, 120))

    const rows = listRows(key)
    const index = rows.findIndex((row) => Number(row.id) === input.recordId)
    if (index < 0) {
      return { ok: false, message: `没有找到编号为 ${input.recordId} 的${meta.entity}` }
    }
    const current = rows[index]
    if (String(current.status) !== abnormalStatus) {
      return {
        ok: false,
        message: `当前状态「${current.status}」不是「${abnormalStatus}」，无需改判或已被处理`,
      }
    }
    const retestValue = input.retestValue.trim()
    if (!retestValue) {
      return { ok: false, message: '请填写复测结论再入库' }
    }

    // 冲突裁决：复测结论与原始读数不一致时，以复测结论为准入库；
    // 原始读数不丢，留在历史版本里可以回看。
    const originalValue = String(current[input.field] ?? '')
    const operator = input.operator?.trim() || '值班管理员'
    const correctedAt = new Date().toISOString()
    const history = listCorrections().filter(
      (item) => item.moduleKey === key && item.recordId === input.recordId,
    )
    const version: CorrectionVersion = {
      moduleKey: key,
      recordId: input.recordId,
      version: history.length + 1,
      field: input.field,
      originalValue,
      retestValue,
      adoptedValue: retestValue,
      basis: '复测结论',
      note: input.note?.trim() ?? '',
      operator,
      correctedAt,
    }
    const recordCode = String(current['记录编号'] ?? input.recordId)
    const attention: AttentionItem = {
      id: `${key}:${input.recordId}:v${version.version}`,
      moduleKey: key,
      recordId: input.recordId,
      title: `${meta.entity} ${recordCode} 异常值已改判入库`,
      detail: `${input.field}：原始读数「${originalValue}」，复测结论「${retestValue}」，以复测结论为准`,
      operator,
      createdAt: correctedAt,
    }
    const updated: EntryRow = {
      ...current,
      [input.field]: retestValue,
      status: target,
      pending: false,
      abnormal: false,
    }

    try {
      updateState((draft) => {
        const list = draft.rows[key] ?? []
        const at = list.findIndex((row) => Number(row.id) === input.recordId)
        if (at >= 0) {
          list[at] = updated
          draft.rows[key] = list
        }
        draft.corrections.push(version)
        draft.attention.push(attention)
      })
    } catch {
      return { ok: false, message: '保存失败：修正面板、观测列表与待办已一起回退到改判前状态' }
    }
    return {
      ok: true,
      message: `${meta.entity}已改判入库（第 ${version.version} 版），当前状态「${target}」`,
    }
  } finally {
    releaseLock(scope)
  }
}

export function listCorrectionVersions(key: string, recordId: number): CorrectionVersion[] {
  return listCorrections()
    .filter((item) => item.moduleKey === key && item.recordId === recordId)
    .sort((a, b) => b.version - a.version)
}

export function listAttentionItems(): AttentionItem[] {
  return [...listAttention()].reverse()
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
