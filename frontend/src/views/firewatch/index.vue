<template>
  <section class="page" data-module="firewatch">
    <header class="page-head">
      <div>
        <h2>火险监测管理</h2>
        <p class="page-desc">维护火险监测点，围绕监测点编号、监测区域、火险等级、风力等级做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记火险监测点</button>
        <button class="btn" type="button" @click="exportRows">导出火险监测清单</button>
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
          <td :colspan="columns.length + 2" class="empty-state">暂无火险监测数据，可先登记火险监测点</td>
        </tr>
      </tbody>
    </table>

    <!-- 气象异常改判同步过来的关注事项：与气象面板/标签页同一持久化单元，改判后实时一致 -->
    <section class="attention-panel">
      <header class="panel-head">
        <h3>关注事项（气象观测同步）</h3>
        <span class="attention-summary">待跟进 {{ pendingAttentions.length }} 条 · 已闭环 {{ closedAttentions.length }} 条</span>
      </header>
      <ul v-if="attentionItems.length" class="attention-list">
        <li v-for="item in attentionItems" :key="item.id" class="attention-item" :class="item.status">
          <span class="attention-status" :class="item.status">{{ item.status }}</span>
          <div class="attention-body">
            <p class="attention-title">{{ item.title }}</p>
            <p class="attention-detail">{{ item.detail }}</p>
            <p class="attention-time">更新于 {{ formatTime(item.updatedAt) }}</p>
          </div>
        </li>
      </ul>
      <p v-else class="empty-state">暂无气象同步的关注事项</p>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条火险监测记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listAttentions,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { AttentionItem, EntryRow } from '@/data/types'

const meta = moduleMeta('firewatch')
const columns = ["监测点编号", "监测区域", "火险等级", "风力等级", "相对湿度", "气温读数", "监测时间", "监测状态"]
const actions = ["更新等级", "解除预警", "升级预警"]
const statuses = ["正常", "蓝色预警", "黄色预警", "橙色预警", "红色预警"]
const stats = ref([{"label": "监测点数", "value": 0}, {"label": "红色预警数", "value": 0}, {"label": "气象关注事项", "value": 0}])

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const attentionItems = ref<AttentionItem[]>([])
const pendingAttentions = computed(() => attentionItems.value.filter((item) => item.status === '待跟进'))
const closedAttentions = computed(() => attentionItems.value.filter((item) => item.status === '已闭环'))
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '火险监测点登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function formatTime(stamp: string): string {
  const date = new Date(stamp)
  return Number.isNaN(date.getTime()) ? stamp : date.toLocaleString()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    // 关注事项与气象改判共用一个持久化单元，动作后重读即可拿到最新那一份。
    attentionItems.value = listAttentions()
    stats.value = [
      {"label": "监测点数", "value": rows.value.length},
      {"label": "红色预警数", "value": rows.value.filter((row) => String(row.status) === '红色预警').length},
      {"label": "气象关注事项", "value": pendingAttentions.value.length},
    ]
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '火险监测列表读取失败'
  }
}

onMounted(reload)
</script>
