/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
  /** 闭环状态：落在这些状态上的记录不再算待办；不填时默认只有末态算闭环。 */
  terminalStatuses?: string[]
  /** 异常状态：落在这些状态上的记录要打 abnormal 标记；不填时按「往回走」动作推断。 */
  abnormalStatuses?: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 一次复测读数：复测结论与原始读数冲突时，以复测结论为准。 */
export type WeatherRevision = {
  气温?: string
  相对湿度?: string
  风速风向?: string
  降水量?: string
}

/** 气象改判历史的单个版本，只追加不改写，旧版本长期保留。 */
export type WeatherVersion = {
  revision: number
  action: '提交审核' | '标记异常' | '确认修正'
  fromStatus: string
  toStatus: string
  basis: '复测结论' | '原始读数'
  original: WeatherRevision
  revised: WeatherRevision
  note: string
  at: string
}

/** 同步到火险监测工作台的关注事项（气象异常改判产生，按气象记录去重）。 */
export type AttentionItem = {
  id: string
  source: 'weather'
  refId: number
  title: string
  detail: string
  status: '待跟进' | '已闭环'
  createdAt: string
  updatedAt: string
}

/** 整库状态：条目、修正版本、关注事项在同一个持久化单元里，一次性提交、一起回退。 */
export type AppState = {
  entries: Record<string, EntryRow[]>
  weatherVersions: Record<number, WeatherVersion[]>
  attentions: AttentionItem[]
}
