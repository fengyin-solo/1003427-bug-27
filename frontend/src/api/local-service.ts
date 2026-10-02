import { MODULE_BY_KEY } from '@/data/modules'
import {
  allRows,
  attentions,
  commit,
  listRows,
  resetRows,
  saveRows,
  weatherVersionsOf,
} from '@/data/local-store'
import type {
  ActionResult,
  AttentionItem,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
  WeatherRevision,
  WeatherVersion,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 气象复测可改判的读数字段；冲突时复测结论覆盖原始读数。
const WEATHER_READING_FIELDS = ['气温', '相对湿度', '风速风向', '降水量'] as const
const WEATHER_ABNORMAL_STATUS = '异常值'
const WEATHER_FIXED_STATUS = '已修正'

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

function terminalStatuses(meta: ModuleMeta): string[] {
  return meta.terminalStatuses ?? [meta.statuses[meta.statuses.length - 1]]
}

function isAbnormalTarget(meta: ModuleMeta, action: string, target: string): boolean {
  if (meta.abnormalStatuses) {
    return meta.abnormalStatuses.includes(target)
  }
  return NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb))
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: !terminalStatuses(meta).includes(target),
    abnormal: isAbnormalTarget(meta, action, target),
  }
  const next = [...rows]
  next[index] = updated
  try {
    saveRows(key, next)
  } catch (error) {
    return {
      ok: false,
      message: `保存失败，改动已全部回退：${error instanceof Error ? error.message : '未知错误'}`,
    }
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
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
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
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

/* ------------------------- 气象异常改判专用链路 ------------------------- */

export function listWeatherVersions(id: number): WeatherVersion[] {
  return weatherVersionsOf(id)
}

export function listAttentions(): AttentionItem[] {
  return attentions()
}

type WeatherAdjudication = 'confirm' | 'remark'

function nowStamp(): string {
  return new Date().toISOString()
}

function pickReadings(row: EntryRow): WeatherRevision {
  const readings: WeatherRevision = {}
  for (const field of WEATHER_READING_FIELDS) {
    const value = row[field]
    if (value !== undefined && value !== '') {
      readings[field] = String(value)
    }
  }
  return readings
}

function normalizeRevision(input: WeatherRevision): WeatherRevision {
  const cleaned: WeatherRevision = {}
  for (const field of WEATHER_READING_FIELDS) {
    const value = input[field]
    if (typeof value === 'string' && value.trim() !== '') {
      cleaned[field] = value.trim()
    }
  }
  return cleaned
}

function upsertWeatherAttention(
  draft: { attentions: AttentionItem[] },
  row: EntryRow,
  status: AttentionItem['status'],
  detail: string,
): void {
  // 按气象记录去重：确认修正与重新标记异常并发时，同一条记录只同步一份关注事项。
  const key = `weather:${row.id}`
  const stamp = nowStamp()
  const title = `气象观测记录 ${String(row['记录编号'] ?? row.id)} 异常复核`
  const index = draft.attentions.findIndex((item) => item.id === key)
  if (index >= 0) {
    draft.attentions[index] = {
      ...draft.attentions[index],
      status,
      detail,
      updatedAt: stamp,
    }
    return
  }
  draft.attentions.push({
    id: key,
    source: 'weather',
    refId: row.id,
    title,
    detail,
    status,
    createdAt: stamp,
    updatedAt: stamp,
  })
}

// 每条气象记录一把串行锁：确认与重新标记并发时排队执行，
// 配合下面的版本号比对，让冲突的第二个动作不再落库（只落一次）。
const weatherLocks = new Map<number, Promise<unknown>>()

function serializeWeather(
  id: number,
  capturedRevision: number,
  task: () => ActionResult,
): Promise<ActionResult> {
  const previous = weatherLocks.get(id) ?? Promise.resolve()
  const next = previous
    .catch(() => undefined)
    .then(() => {
      // 排队期间已经有改判落库（版本号变了），本次直接判冲突，不再写第二笔。
      if (weatherVersionsOf(id).length !== capturedRevision) {
        return {
          ok: false,
          message: '该记录刚被另一路改判处理过，请刷新面板后按最新状态操作',
        } satisfies ActionResult
      }
      return task()
    })
  const stored = next.catch(() => undefined)
  weatherLocks.set(
    id,
    stored.finally(() => {
      if (weatherLocks.get(id) === stored) {
        weatherLocks.delete(id)
      }
    }),
  )
  return next
}

function adjudicateWeather(
  id: number,
  kind: WeatherAdjudication,
  input: WeatherRevision = {},
): Promise<ActionResult> {
  const rows = listRows('weather')
  const row = rows.find((item) => Number(item.id) === id)
  if (!row) {
    return Promise.resolve({ ok: false, message: `没有找到编号为 ${id} 的气象观测记录` })
  }
  const currentStatus = String(row.status)
  if (kind === 'confirm' && currentStatus !== WEATHER_ABNORMAL_STATUS) {
    return Promise.resolve({
      ok: false,
      message: `只有「${WEATHER_ABNORMAL_STATUS}」记录才能复测改判，当前状态为「${currentStatus}」`,
    })
  }
  if (kind === 'remark' && currentStatus === WEATHER_ABNORMAL_STATUS) {
    return Promise.resolve({
      ok: false,
      message: `该记录已经是「${WEATHER_ABNORMAL_STATUS}」，不用重复标记`,
    })
  }

  // 版本号在入队前读取：并发进来的两路拿到同一个号，只有第一路能落库。
  const capturedRevision = weatherVersionsOf(id).length
  const revised = normalizeRevision(input)
  const original = pickReadings(row)

  return serializeWeather(id, capturedRevision, () => {
    const history = weatherVersionsOf(id)
    const nextRevision = history.length + 1
    try {
      commit((draft) => {
        const currentRows = draft.entries.weather
        const index = currentRows.findIndex((item) => Number(item.id) === id)
        const currentRow = currentRows[index]

        let updatedRow: EntryRow
        let version: WeatherVersion
        if (kind === 'confirm') {
          // 冲突时以复测结论为准：复测读数覆盖原始读数；未填复测项时维持原始读数。
          const useRevised = Object.keys(revised).length > 0
          updatedRow = {
            ...currentRow,
            ...revised,
            status: WEATHER_FIXED_STATUS,
            pending: false,
            abnormal: false,
          }
          version = {
            revision: nextRevision,
            action: '确认修正',
            fromStatus: WEATHER_ABNORMAL_STATUS,
            toStatus: WEATHER_FIXED_STATUS,
            basis: useRevised ? '复测结论' : '原始读数',
            original,
            revised,
            note: useRevised
              ? '复测读数与原始读数冲突，以复测结论改判入库'
              : '未提供复测读数，维持原始读数并确认修正',
            at: nowStamp(),
          }
          upsertWeatherAttention(
            draft,
            currentRow,
            '已闭环',
            `复测改判为「${WEATHER_FIXED_STATUS}」，依据：${version.basis}`,
          )
        } else {
          // 重新标记异常：读数以原始读数为准，记录回到异常态，继续待跟进。
          updatedRow = {
            ...currentRow,
            status: WEATHER_ABNORMAL_STATUS,
            pending: true,
            abnormal: true,
          }
          version = {
            revision: nextRevision,
            action: '标记异常',
            fromStatus: String(currentRow.status),
            toStatus: WEATHER_ABNORMAL_STATUS,
            basis: '原始读数',
            original,
            revised: {},
            note: '复测后仍判定为异常，以原始读数为准重新标记',
            at: nowStamp(),
          }
          upsertWeatherAttention(
            draft,
            currentRow,
            '待跟进',
            `复测后仍判定异常，已重新标记为「${WEATHER_ABNORMAL_STATUS}」，待跟进处理`,
          )
        }

        draft.entries.weather = [...currentRows]
        draft.entries.weather[index] = updatedRow
        draft.weatherVersions[id] = [...history, version]
      })
    } catch (error) {
      // commit 已把内存缓存回退到提交前：面板、标签页、待办保持同一旧状态。
      return {
        ok: false,
        message: `保存失败，面板、标签页与待办已一并回退：${
          error instanceof Error ? error.message : '未知错误'
        }`,
      }
    }
    return kind === 'confirm'
      ? { ok: true, message: `复测改判已入库，当前状态「${WEATHER_FIXED_STATUS}」` }
      : { ok: true, message: `已重新标记为「${WEATHER_ABNORMAL_STATUS}」` }
  })
}

/** 异常记录复测改判：以复测结论为准，落「已修正」并留存版本、同步关注事项。 */
export function confirmWeatherRevision(id: number, revised: WeatherRevision): Promise<ActionResult> {
  return adjudicateWeather(id, 'confirm', revised)
}

/** 复测后仍判定异常：以原始读数为准重新标记，并把关注事项置为待跟进。 */
export function remarkWeatherAbnormal(id: number): Promise<ActionResult> {
  return adjudicateWeather(id, 'remark')
}
