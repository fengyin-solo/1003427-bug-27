<template>
  <section class="page" data-module="weather">
    <header class="page-head">
      <div>
        <h2>气象观测管理</h2>
        <p class="page-desc">维护气象观测记录，围绕记录编号、观测站点、观测时间、气温做登记、筛选与状态流转。</p>
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

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

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
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无气象观测数据，可先登记气象观测记录</td>
        </tr>
      </tbody>
    </table>

    <section v-if="panelRow" class="correction-panel" data-panel="correction">
      <header class="panel-head">
        <h3>异常值改判 · {{ panelRow['记录编号'] }}</h3>
        <span class="panel-meta">
          {{ panelRow['观测站点'] }} · {{ panelRow['观测时间'] }} · 当前状态：{{ panelRow.status }}
        </span>
      </header>

      <div class="panel-grid">
        <label class="panel-item">
          <span>修正字段</span>
          <select v-model="panelField" :disabled="saving">
            <option v-for="field in measureFields" :key="field" :value="field">{{ field }}</option>
          </select>
        </label>
        <div class="panel-item">
          <span>原始读数</span>
          <strong>{{ panelOriginal }}</strong>
        </div>
        <label class="panel-item">
          <span>复测结论</span>
          <input v-model="retestValue" :disabled="saving" placeholder="填写复测后的读数" />
        </label>
        <label class="panel-item">
          <span>备注</span>
          <input v-model="correctionNote" :disabled="saving" placeholder="改判依据，可留空" />
        </label>
      </div>
      <p class="panel-policy">复测结论与原始读数不一致时，以复测结论为准入库；原始读数保留在历史版本中。</p>

      <div v-if="versions.length" class="panel-history">
        <h4>历史修正记录</h4>
        <ul>
          <li v-for="item in versions" :key="item.version">
            第 {{ item.version }} 版 · {{ formatTime(item.correctedAt) }} · {{ item.operator }} ·
            {{ item.field }}：「{{ item.originalValue }}」→「{{ item.adoptedValue }}」（以{{ item.basis }}为准）
            <template v-if="item.note">· {{ item.note }}</template>
          </li>
        </ul>
      </div>

      <footer class="panel-foot">
        <button class="btn primary" type="button" :disabled="saving" @click="submitCorrection">
          {{ saving ? '入库中…' : '确认改判入库' }}
        </button>
        <button class="btn ghost" type="button" :disabled="saving" @click="closeCorrection">取消</button>
        <span v-if="panelError" class="error-text">{{ panelError }}</span>
      </footer>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条气象观测记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  confirmCorrection,
  downloadEntries,
  listCorrectionVersions,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { CorrectionVersion, EntryRow } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const meta = moduleMeta('weather')
const store = useSessionStore()
const columns = ["记录编号", "观测站点", "观测时间", "气温", "相对湿度", "风速风向", "降水量", "记录状态"]
const actions = ["提交审核", "确认数据", "标记异常"]
const statuses = ["已录入", "已审核", "异常值", "已修正"]
const stats = [{"label": "今日观测数", "value": 0}, {"label": "待审核记录", "value": 0}, {"label": "异常记录数", "value": 0}]
// 改判面板里允许复核的观测量
const measureFields = ["气温", "相对湿度", "风速风向", "降水量"]
const abnormalStatus = "异常值"

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 修正面板状态：面板展示的数据始终来自列表（即来自存储），不另存副本，避免与标签页错位
const panelRow = ref<EntryRow | null>(null)
const panelField = ref(measureFields[0])
const retestValue = ref('')
const correctionNote = ref('')
const panelError = ref('')
const saving = ref(false)
const versions = ref<CorrectionVersion[]>([])

const panelOriginal = computed(() =>
  panelRow.value ? String(panelRow.value[panelField.value] ?? '—') : '—',
)

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

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  // 异常值记录走修正面板改判入库；其余动作走通用流转
  if (action === '确认数据' && String(row.status) === abnormalStatus) {
    openCorrection(row)
    return
  }
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function openCorrection(row: EntryRow) {
  if (saving.value) {
    return
  }
  panelRow.value = row
  panelField.value = measureFields[0]
  retestValue.value = ''
  correctionNote.value = ''
  panelError.value = ''
  versions.value = listCorrectionVersions(meta.key, Number(row.id))
}

function closeCorrection() {
  if (saving.value) {
    return
  }
  panelRow.value = null
}

// 保存失败时，面板里的记录回退到存储里的最新状态，和标签页、待办保持一致
function syncPanelRow() {
  if (!panelRow.value) {
    return
  }
  const fresh = rows.value.find((row) => Number(row.id) === Number(panelRow.value?.id))
  panelRow.value = fresh ?? null
  if (panelRow.value) {
    versions.value = listCorrectionVersions(meta.key, Number(panelRow.value.id))
  }
}

async function submitCorrection() {
  if (!panelRow.value || saving.value) {
    return
  }
  panelError.value = ''
  saving.value = true
  try {
    const result = await confirmCorrection(meta.key, {
      recordId: Number(panelRow.value.id),
      field: panelField.value,
      retestValue: retestValue.value,
      note: correctionNote.value,
      operator: store.operator,
    })
    reload()
    if (!result.ok) {
      panelError.value = result.message
      syncPanelRow()
      return
    }
    panelRow.value = null
  } finally {
    saving.value = false
  }
}

function formatTime(iso: string) {
  const time = new Date(iso)
  return Number.isNaN(time.getTime()) ? iso : time.toLocaleString('zh-CN')
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '气象观测列表读取失败'
  }
}

onMounted(reload)
</script>
