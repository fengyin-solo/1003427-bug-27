import { SEED_ROWS } from './seed'
import type { AttentionItem, CorrectionVersion, EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'forest-fire-patrol:entries'
const STATE_VERSION = 2

// 持久化的完整形态：业务行 + 改判版本 + 关注事项，放在同一个键下整体读写，
// 这样一次改判涉及的多处变更要么一起落盘、要么一起不落。
export type PersistedState = {
  version: number
  rows: Record<string, EntryRow[]>
  corrections: CorrectionVersion[]
  attention: AttentionItem[]
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function seedState(): PersistedState {
  return { version: STATE_VERSION, rows: clone(SEED_ROWS), corrections: [], attention: [] }
}

// 兼容旧版：v1 存的就是裸的 rows 字典（没有 version 字段），读出来包一层即可。
function migrate(parsed: unknown): PersistedState {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return seedState()
  }
  const obj = parsed as Record<string, unknown>
  if (obj.version === STATE_VERSION && obj.rows && typeof obj.rows === 'object') {
    return {
      version: STATE_VERSION,
      rows: { ...clone(SEED_ROWS), ...(obj.rows as Record<string, EntryRow[]>) },
      corrections: Array.isArray(obj.corrections) ? (obj.corrections as CorrectionVersion[]) : [],
      attention: Array.isArray(obj.attention) ? (obj.attention as AttentionItem[]) : [],
    }
  }
  return { ...seedState(), rows: { ...clone(SEED_ROWS), ...(obj as Record<string, EntryRow[]>) } }
}

function readStorage(): PersistedState {
  const fallback = seedState()
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    } catch {
      // 存储不可用（如配额满）时只退回内存态，不让首屏直接崩掉
    }
    return fallback
  }
  try {
    return migrate(JSON.parse(raw))
  } catch {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    } catch {
      // 同上：写不进去就用内存态兜底
    }
    return fallback
  }
}

let cache: PersistedState | null = null

function currentState(): PersistedState {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

// 原子提交：先写 localStorage，成功之后才替换内存快照。
// 写盘失败会抛错且内存保持原样 —— 内存与磁盘始终是同一份，刷新、重进看到的结果一致。
function commit(next: PersistedState): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
  cache = next
}

// 所有写操作的唯一入口：在克隆草稿上改，整体提交；任何一步失败，调用方拿到的还是旧状态。
export function updateState(mutator: (draft: PersistedState) => void): void {
  const draft = clone(currentState())
  mutator(draft)
  commit(draft)
}

export function allRows(): Record<string, EntryRow[]> {
  return currentState().rows
}

export function listRows(key: string): EntryRow[] {
  return currentState().rows[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  updateState((draft) => {
    draft.rows[key] = rows
  })
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  updateState((draft) => {
    draft.rows[key] = rows
  })
  return rows
}

export function listCorrections(): CorrectionVersion[] {
  return currentState().corrections
}

export function listAttention(): AttentionItem[] {
  return currentState().attention
}

export function storageKey(): string {
  return STORAGE_KEY
}
