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

/** 异常值改判的历史版本：每次改判入库追加一条，原始读数与复测结论都留痕。 */
export type CorrectionVersion = {
  moduleKey: string
  recordId: number
  version: number
  field: string
  originalValue: string
  retestValue: string
  adoptedValue: string
  basis: string
  note: string
  operator: string
  correctedAt: string
}

/** 火险监测工作台的关注事项：由其他模块（如气象观测改判）同步过来。 */
export type AttentionItem = {
  id: string
  moduleKey: string
  recordId: number
  title: string
  detail: string
  operator: string
  createdAt: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
