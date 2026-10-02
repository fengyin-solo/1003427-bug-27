<template>
  <section class="page" data-module="weather">
    <header class="page-head">
      <div>
        <h2>气象观测管理</h2>
        <p class="page-desc">维护气象观测记录，围绕记录编号、观测站点、观测时间、气温做登记、筛选与状态流转；异常读数复测后在修正面板改判。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记气象观测记录</button>
        <button class="btn" type="button" @click="exportRows">导出气象观测清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <!-- 观测标签页：标签直接读数据层状态，改判入库后与修正面板同源刷新，不再停在旧状态 -->
    <nav class="tab-bar" aria-label="观测状态标签">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        type="button"
        class="tab"
        :class="{ active: activeTab === tab.key }"
        @click="switchTab(tab.key)"
      >
        {{ tab.label }}
        <span class="tab-count">{{ tab.count }}</span>
      </button>
    </nav>

    <div class="workbench">
      <div class="workbench-main">
        <form class="filter-bar" @submit.prevent="reload">
          <label v-for="field in filterFields" :key="field" class="filter-item">
            <span>{{ field }}</span>
            <input v-model="filters[field]" :placeholder="`按${field}检索`" />
          </label>
          <button class="btn" type="submit">查询</button>
          <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
        </form>

        <table class="data-table">
          <thead>
            <tr>
              <th v-for="column in columns" :key="column">{{ column }}</th>
              <th>当前状态</th>
              <th>可执行动作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in visibleRows" :key="String(row.id)">
              <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
              <td>
                <span class="status-pill" :class="{ abnormal: row.abnormal }">{{ row.status }}</span>
              </td>
              <td class="row-actions">
                <button
                  v-if="row.status === '已录入'"
                  class="link"
                  type="button"
                  :disabled="busyId === row.id"
                  @click="submitReview(row)"
                >
                  提交审核
                </button>
                <button
                  v-if="row.status === '异常值'"
                  class="link"
                  type="button"
                  :disabled="busyId === row.id"
                  @click="openPanel(row)"
                >
                  去修正
                </button>
                <button
                  v-else
                  class="link"
                  type="button"
                  :disabled="busyId === row.id"
                  @click="openPanel(row)"
                >
                  改判记录
                </button>
              </td>
            </tr>
            <tr v-if="!visibleRows.length">
              <td :colspan="columns.length + 2" class="empty-state">
                {{ activeTab === 'all' ? '暂无气象观测数据，可先登记气象观测记录' : '该标签下暂无记录' }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 异常改判面板：复测结论与原始读数冲突时以复测结论为准 -->
      <aside class="correction-panel">
        <header class="panel-head">
          <h3>异常改判面板</h3>
          <button v-if="panelRow" class="link" type="button" @click="closePanel">收起</button>
        </header>

        <p v-if="!panelRow" class="panel-empty">在列表中对「异常值」记录点「去修正」，或对其他记录点「改判记录」查看版本。</p>

        <template v-else>
          <p class="panel-record">
            {{ panelRow['记录编号'] }} · {{ panelRow['观测站点'] }}
            <span class="status-pill" :class="{ abnormal: panelRow.status === '异常值' }">{{ panelRow.status }}</span>
          </p>

          <div class="reading-block">
            <h4>原始读数</h4>
            <dl>
              <div v-for="field in readingFields" :key="field">
                <dt>{{ field }}</dt>
                <dd>{{ panelRow[field] || '—' }}</dd>
              </div>
            </dl>
          </div>

          <div class="reading-block" v-if="panelRow.status === '异常值'">
            <h4>复测读数（留空项维持原始读数）</h4>
            <label v-for="field in readingFields" :key="field" class="recheck-item">
              <span>{{ field }}</span>
              <input v-model="recheck[field]" :placeholder="`复测${field}`" :disabled="busy" />
            </label>
            <p class="panel-hint">复测与原始读数冲突时，以复测结论改判入库。</p>
            <div class="panel-actions">
              <button
                class="btn primary"
                type="button"
                :disabled="busy"
                @click="confirmRevision"
              >
                {{ busy ? '处理中…' : '确认修正（以复测为准）' }}
              </button>
              <button class="btn" type="button" :disabled="busy" @click="remarkAbnormal">
                重新标记异常
              </button>
            </div>
          </div>

          <div class="version-block">
            <h4>历史修正记录（版本留存）</h4>
            <ol v-if="panelVersions.length" class="version-list">
              <li v-for="version in panelVersions" :key="version.revision">
                <p class="version-line">
                  <strong>v{{ version.revision }} · {{ version.action }}</strong>
                  {{ version.fromStatus }} → {{ version.toStatus }}
                  <span class="version-basis" :class="{ revised: version.basis === '复测结论' }">
                    依据：{{ version.basis }}
                  </span>
                </p>
                <p class="version-note">{{ version.note }}</p>
                <p class="version-time">{{ formatTime(version.at) }}</p>
              </li>
            </ol>
            <p v-else class="panel-empty">该记录暂无改判版本。</p>
          </div>
        </template>
      </aside>
    </div>

    <footer class="page-foot">
      <span>共 {{ total }} 条气象观测记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  confirmWeatherRevision,
  downloadEntries,
  listEntries,
  listWeatherVersions,
  moduleMeta,
  remarkWeatherAbnormal,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow, WeatherRevision, WeatherVersion } from '@/data/types'

const meta = moduleMeta('weather')
const columns = ['记录编号', '观测站点', '观测时间', '气温', '相对湿度', '风速风向', '降水量', '记录状态']
const readingFields = ['气温', '相对湿度', '风速风向', '降水量'] as const
const stats = ref([
  { label: '今日观测数', value: 0 },
  { label: '待审核记录', value: 0 },
  { label: '异常记录数', value: 0 },
])

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const activeTab = ref<'all' | string>('all')
const tabs = computed(() => [
  { key: 'all', label: '全部', count: rows.value.length },
  ...meta.statuses.map((status) => ({
    key: status,
    label: status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
])
const visibleRows = computed(() =>
  activeTab.value === 'all'
    ? rows.value
    : rows.value.filter((row) => String(row.status) === activeTab.value),
)

const panelRow = ref<EntryRow | null>(null)
const panelVersions = ref<WeatherVersion[]>([])
const recheck = ref<WeatherRevision>({})
const busy = ref(false)
const busyId = ref<number | null>(null)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '气象观测记录登记入口尚未接入审批流'
}

function switchTab(key: string) {
  activeTab.value = key
}

// 面板与标签页同源于 rows：每次改判后整表、统计、面板一起从数据层重读，杜绝错位。
function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    stats.value = [
      { label: '今日观测数', value: rows.value.length },
      { label: '待审核记录', value: rows.value.filter((row) => row.pending).length },
      { label: '异常记录数', value: rows.value.filter((row) => row.abnormal).length },
    ]
    if (panelRow.value) {
      const latest = rows.value.find((row) => Number(row.id) === Number(panelRow.value?.id))
      panelRow.value = latest ?? null
      panelVersions.value = latest ? listWeatherVersions(Number(latest.id)) : []
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '气象观测列表读取失败'
  }
}

function submitReview(row: EntryRow) {
  errorMessage.value = ''
  busyId.value = Number(row.id)
  const result = applyAction(meta.key, Number(row.id), '提交审核')
  busyId.value = null
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function openPanel(row: EntryRow) {
  errorMessage.value = ''
  panelRow.value = row
  panelVersions.value = listWeatherVersions(Number(row.id))
  recheck.value = {}
}

function closePanel() {
  panelRow.value = null
  panelVersions.value = []
  recheck.value = {}
}

async function runAdjudication(task: () => Promise<{ ok: boolean; message: string }>) {
  if (!panelRow.value) {
    return
  }
  const id = Number(panelRow.value.id)
  busy.value = true
  busyId.value = id
  errorMessage.value = ''
  try {
    const result = await task()
    if (!result.ok) {
      // 保存失败或并发冲突：服务层未改动数据，这里重读即可恢复到同一旧状态（一起回退）。
      errorMessage.value = result.message
      reload()
      return
    }
    reload()
  } finally {
    busy.value = false
    busyId.value = null
  }
}

function confirmRevision() {
  if (!panelRow.value) {
    return
  }
  const id = Number(panelRow.value.id)
  const payload = { ...recheck.value }
  void runAdjudication(() => confirmWeatherRevision(id, payload))
}

function remarkAbnormal() {
  if (!panelRow.value) {
    return
  }
  const id = Number(panelRow.value.id)
  void runAdjudication(() => remarkWeatherAbnormal(id))
}

function formatTime(stamp: string): string {
  const date = new Date(stamp)
  return Number.isNaN(date.getTime()) ? stamp : date.toLocaleString()
}

onMounted(reload)
</script>
