/* 迁移冒烟：旧版（v1，裸 rows 字典）存储能被正确读取并升级，改判链路在迁移后的数据上可用。 */
import { confirmCorrection, listAttentionItems, listCorrectionVersions, runAction } from '../src/api/local-service'
import { listRows, storageKey } from '../src/data/local-store'

const v1 = {
  weather: [
    { id: 9, status: '异常值', pending: true, abnormal: true, 记录编号: 'WEAT-OLD', 观测站点: '老站', 观测时间: '2026-09-09', 气温: '41℃' },
  ],
  patrol: [{ id: 1, status: '待执行', pending: true, abnormal: false, 任务编号: 'PATR-OLD' }],
}
const store: Record<string, string> = { ['forest-fire-patrol:entries']: JSON.stringify(v1) }
;(globalThis as any).window = {
  localStorage: {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => {
      store[k] = String(v)
    },
    removeItem: (k: string) => {
      delete store[k]
    },
  },
}

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
  const row = listRows('weather').find((x) => x.id === 9)
  check('v1 数据可读', row?.status === '异常值' && row['气温'] === '41℃', row)
  check('v1 缺失模块回退到种子数据', listRows('firewatch').length > 0)

  const res = await confirmCorrection('weather', { recordId: 9, field: '气温', retestValue: '38℃' })
  check('迁移后改判成功', res.ok, res)
  check('迁移后版本从 1 开始', listCorrectionVersions('weather', 9)[0]?.version === 1)
  check('迁移后关注事项同步', listAttentionItems().length === 1)

  const persisted = JSON.parse(store[storageKey()])
  check('落盘为 v2 结构', persisted.version === 2 && Array.isArray(persisted.corrections), persisted.version)
  check('v1 行数据保留', persisted.rows.weather.some((x: any) => x.id === 9))
  check('v1 其他模块数据保留', persisted.rows.patrol.some((x: any) => x.id === 1))

  const r = runAction('patrol', 1, '开始巡护')
  check('迁移后其他模块可流转', r.ok, r)

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
