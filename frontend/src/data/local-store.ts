import { SEED_ROWS } from './seed'
import type { AppState, AttentionItem, EntryRow, WeatherVersion } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'forest-fire-patrol:entries'

// 旧版本只存了条目（数组形态），首次读到时迁移到带版本记录、关注事项的新结构，
// 迁移结果立即落库，刷新、重新进入读到的就是同一份状态。
const LEGACY_VERSION_KEY = 'forest-fire-patrol:weather-versions'
const LEGACY_ATTENTION_KEY = 'forest-fire-patrol:attentions'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function seedState(): AppState {
  return { entries: clone(SEED_ROWS), weatherVersions: {}, attentions: [] }
}

function hasStorage(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage
}

function normalizeLegacyEntries(entries: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  // 旧数据里异常记录的 pending/abnormal 可能和状态错位，读入时只做这一次对齐：
  // 「异常值」必须既待办又异常，「已修正」才算办结。
  const weather = (entries.weather ?? []).map((row) => {
    if (String(row.status) === '异常值') {
      return { ...row, pending: true, abnormal: true }
    }
    if (String(row.status) === '已修正') {
      return { ...row, pending: false, abnormal: false }
    }
    return row
  })
  return { ...entries, weather }
}

function readLegacySidecar<T>(key: string, fallback: T): T {
  if (!hasStorage()) {
    return fallback
  }
  const raw = window.localStorage.getItem(key)
  if (!raw) {
    return fallback
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function readState(): AppState {
  if (!hasStorage()) {
    return seedState()
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const seeded = seedState()
    writeStorage(seeded)
    return seeded
  }
  try {
    const parsed = JSON.parse(raw) as AppState | Record<string, EntryRow[]>
    // 新结构（对象里带 entries）；否则按旧的「纯条目表」迁移。
    if (parsed && !Array.isArray(parsed) && 'entries' in parsed) {
      const next = parsed as AppState
      return {
        entries: { ...clone(SEED_ROWS), ...normalizeLegacyEntries(clone(next.entries ?? {})) },
        weatherVersions: clone(next.weatherVersions ?? {}),
        attentions: clone(next.attentions ?? []),
      }
    }
    const legacyEntries = normalizeLegacyEntries({
      ...clone(SEED_ROWS),
      ...(parsed as Record<string, EntryRow[]>),
    })
    const migrated: AppState = {
      entries: legacyEntries,
      weatherVersions: readLegacySidecar<Record<number, WeatherVersion[]>>(LEGACY_VERSION_KEY, {}),
      attentions: readLegacySidecar<AttentionItem[]>(LEGACY_ATTENTION_KEY, []),
    }
    writeStorage(migrated)
    // 旧的旁路键已经并入主库，清掉避免后续两份数据漂移。
    window.localStorage.removeItem(LEGACY_VERSION_KEY)
    window.localStorage.removeItem(LEGACY_ATTENTION_KEY)
    return migrated
  } catch {
    const seeded = seedState()
    writeStorage(seeded)
    return seeded
  }
}

function writeStorage(state: AppState): void {
  if (hasStorage()) {
    // 单次 setItem 是一个原子写入；异常向外抛，由提交方回退内存缓存。
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }
}

let cache: AppState | null = null

export function state(): AppState {
  if (cache === null) {
    cache = readState()
  }
  return cache
}

export function allRows(): Record<string, EntryRow[]> {
  return state().entries
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function weatherVersionsOf(id: number): WeatherVersion[] {
  return state().weatherVersions[id] ?? []
}

export function allWeatherVersions(): Record<number, WeatherVersion[]> {
  return state().weatherVersions
}

export function attentions(): AttentionItem[] {
  return state().attentions
}

/**
 * 事务性提交：先在草稿上改完条目、版本、关注事项，再一次性落库。
 * localStorage 写入抛错时恢复提交前的内存快照并向上抛，
 * 面板、标签页、待办看到的仍是同一份旧状态（一起回退，不留半截）。
 */
export function commit(mutate: (draft: AppState) => void): AppState {
  const snapshot = cache === null ? null : clone(cache)
  const base = clone(state())
  mutate(base)
  const previous = cache
  cache = base
  try {
    writeStorage(base)
  } catch (error) {
    cache = previous ?? snapshot
    throw error
  }
  return base
}

/** 兼容旧调用：整表替换仍走同一笔事务，保证保存失败时缓存一并回退。 */
export function saveRows(key: string, rows: EntryRow[]): void {
  commit((draft) => {
    draft.entries[key] = rows
  })
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  commit((draft) => {
    draft.entries[key] = rows
    if (key === 'weather') {
      // 模块重置连版本与关注事项一起回到示例态，避免残留指向已不存在的改判。
      draft.weatherVersions = {}
      draft.attentions = draft.attentions.filter((item) => item.source !== 'weather')
    }
  })
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

/** 测试钩子：丢弃内存缓存，模拟刷新页面后从 localStorage 重新读库（生产代码不调用）。 */
export function __resetCacheForTest(): void {
  cache = null
}
