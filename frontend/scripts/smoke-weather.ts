/* 冒烟测试：模拟完整改判链路，验证状态机、版本留痕、关注事项同步、并发只落一次、失败回退。 */
import {
  confirmCorrection,
  listAttentionItems,
  listCorrectionVersions,
  runAction,
} from '../src/api/local-service'
import { listRows, storageKey } from '../src/data/local-store'

// ---- localStorage 模拟：可控制写盘失败 ----
let store: Record<string, string> = {}
let failWrites = false
const localStorageShim = {
  getItem: (k: string) => (k in store ? store[k] : null),
  setItem: (k: string, v: string) => {
    if (failWrites) throw new Error('QuotaExceededError')
    store[k] = String(v)
  },
  removeItem: (k: string) => {
    delete store[k]
  },
}
;(globalThis as any).window = { localStorage: localStorageShim }

let failures = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ok  ${name}`)
  } else {
    failures += 1
    console.error(`FAIL  ${name}`, extra === undefined ? '' : JSON.stringify(extra))
  }
}
async function main() {
  // ---------- 1. 标记异常：状态、abnormal、pending 都要对 ----------
  let r = runAction('weather', 1, '标记异常')
  check('标记异常成功', r.ok, r)
  let row = listRows('weather').find((x) => x.id === 1)!
  check('标记异常后状态=异常值', row.status === '异常值', row)
  check('标记异常后 abnormal=true', row.abnormal === true, row)
  check('标记异常后 pending=true（进入待办）', row.pending === true, row)

  // 重复标记：同状态守卫
  r = runAction('weather', 1, '标记异常')
  check('重复标记异常被拒绝', !r.ok, r)

  // ---------- 2. 改判入库：复测结论为准，版本+1，关注事项+1 ----------
  const before = listAttentionItems().length
  const p = confirmCorrection('weather', {
    recordId: 1,
    field: '气温',
    retestValue: '26.5℃',
    note: '复测正常',
    operator: '测试员',
  })
  // 并发：入库进行中再次确认 + 重新标记异常，都应只落一次
  const dup = await confirmCorrection('weather', { recordId: 1, field: '气温', retestValue: '99℃' })
  check('并发重复确认被锁拒绝', !dup.ok, dup)
  const race = runAction('weather', 1, '标记异常')
  check('并发重新标记异常被锁拒绝', !race.ok, race)
  const res = await p
  check('改判入库成功', res.ok, res)

  row = listRows('weather').find((x) => x.id === 1)!
  check('改判后状态=已修正', row.status === '已修正', row)
  check('改判后气温=复测结论（复测为准）', row['气温'] === '26.5℃', row)
  check('改判后 abnormal=false', row.abnormal === false, row)
  check('改判后 pending=false（离开待办）', row.pending === false, row)

  const versions = listCorrectionVersions('weather', 1)
  check('历史版本=1', versions.length === 1, versions)
  check('版本保留原始读数', versions[0]?.originalValue === '气象观测样例1', versions[0])
  check('版本采用值=复测结论', versions[0]?.adoptedValue === '26.5℃', versions[0])
  check('版本号=1', versions[0]?.version === 1, versions[0])

  const attention = listAttentionItems()
  check('火险监测关注事项+1', attention.length === before + 1, attention)
  check('关注事项指向该记录', attention[0]?.recordId === 1 && attention[0]?.moduleKey === 'weather', attention[0])

  // ---------- 3. 已修正记录再次确认：不生效 ----------
  const again = await confirmCorrection('weather', { recordId: 1, field: '气温', retestValue: '30℃' })
  check('已修正后再次改判被拒绝', !again.ok, again)
  check('版本数仍为 1', listCorrectionVersions('weather', 1).length === 1)
  check('关注事项不重复增加', listAttentionItems().length === before + 1)

  // ---------- 4. 重新标记异常 → 再次改判：版本累积 ----------
  r = runAction('weather', 1, '标记异常')
  check('已修正可重新标记异常', r.ok && listRows('weather').find((x) => x.id === 1)!.status === '异常值', r)
  const res2 = await confirmCorrection('weather', { recordId: 1, field: '气温', retestValue: '27.1℃' })
  check('第二次改判成功', res2.ok, res2)
  const v2 = listCorrectionVersions('weather', 1)
  check('历史版本=2（保留版本）', v2.length === 2, v2)
  check('第二版 version=2', v2[0]?.version === 2, v2[0])
  check('第二版原始读数=上一版复测值', v2[0]?.originalValue === '26.5℃', v2[0])
  check('关注事项再+1', listAttentionItems().length === before + 2)

  // ---------- 5. 持久化一致性：模拟刷新（清内存缓存不可能直接做，改验证磁盘内容） ----------
  const persisted = JSON.parse(store[storageKey()])
  check('磁盘行状态=已修正', persisted.rows.weather.find((x: any) => x.id === 1).status === '已修正')
  check('磁盘版本=2', persisted.corrections.length === 2)
  check('磁盘关注事项=2', persisted.attention.length === 2)

  // ---------- 6. 保存失败：面板/标签页/待办一起回退 ----------
  runAction('weather', 2, '标记异常')
  const snapRows = JSON.stringify(listRows('weather'))
  const snapCorrections = JSON.stringify(listCorrectionVersions('weather', 2))
  const snapAttention = JSON.stringify(listAttentionItems())
  const snapDisk = store[storageKey()]
  failWrites = true
  const fail = await confirmCorrection('weather', { recordId: 2, field: '气温', retestValue: '31℃' })
  failWrites = false
  check('写盘失败时改判返回失败', !fail.ok, fail)
  check('失败后内存行状态回退', JSON.stringify(listRows('weather')) === snapRows)
  check('失败后版本未增加', JSON.stringify(listCorrectionVersions('weather', 2)) === snapCorrections)
  check('失败后关注事项未增加', JSON.stringify(listAttentionItems()) === snapAttention)
  check('失败后磁盘未变化', store[storageKey()] === snapDisk)
  check('失败后内存与磁盘一致', JSON.stringify(JSON.parse(store[storageKey()]).rows.weather) === JSON.stringify(listRows('weather')))

  // runAction 写盘失败也要回退
  failWrites = true
  const failAction = runAction('weather', 2, '提交审核')
  failWrites = false
  check('runAction 写盘失败返回失败', !failAction.ok, failAction)
  check('runAction 失败后状态保持异常值', listRows('weather').find((x) => x.id === 2)!.status === '异常值')

  // ---------- 7. 通用流转不受影响 ----------
  r = runAction('weather', 3, '提交审核')
  check('提交审核→已审核', r.ok && listRows('weather').find((x) => x.id === 3)!.status === '已审核', r)
  r = runAction('weather', 3, '确认数据')
  check('确认数据→已修正（通用路径）', r.ok && listRows('weather').find((x) => x.id === 3)!.status === '已修正', r)
  check('通用确认后 pending=false', listRows('weather').find((x) => x.id === 3)!.pending === false)
  const pr = runAction('patrol', 1, '开始巡护')
  check('其他模块流转正常', pr.ok && listRows('patrol').find((x) => x.id === 1)!.status === '执行中', pr)

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
