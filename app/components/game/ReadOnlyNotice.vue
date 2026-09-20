<script setup lang="ts">
/**
 * 只读视图：另一标签页进行中 / 浏览器缺少 Web Locks 两种情形。
 * 只读页不能发起 AI、修改存档、清除或开始新局；设置不受此锁限制。
 */
import type { GameState } from '#shared/game'
import { computed } from 'vue'

const props = defineProps<{
  /** readonly-locked：对局在另一标签页进行；no-lock-browser：浏览器缺少 Web Locks。 */
  mode: 'locked' | 'no-lock'
  state: GameState | null
  /** 槽位存在但无法读取。 */
  invalidMessage: string | null
}>()

const emit = defineEmits<{
  (e: 'takeControl'): void
  (e: 'startTemp'): void
}>()

const headline = computed(() =>
  props.mode === 'locked' ? '对局正在另一标签页中进行' : '此浏览器不支持多标签页锁定',
)

const description = computed(() =>
  props.mode === 'locked'
    ? '同一时间只有一个标签页可以操作对局。当前页面为只读快照；在控制页关闭或返回入口后，可以在这里继续。'
    : '此浏览器没有 Web Locks 支持，无法安全地继续本地存档。你可以查看存档，或开始一局不保存的临时对局（刷新后不会保留）。',
)

const finishedText = computed(() => {
  const state = props.state
  if (!state || state.phase.kind !== 'finished') {
    return null
  }
  const result = state.phase.result
  if (result.reason === 'empty-hand') {
    return `胜者：${state.players.find(p => p.id === result.winnerId)?.name ?? ''}`
  }
  return '和局'
})
</script>

<template>
  <div class="rounded-xl border border-[var(--border-default)] bg-[var(--surface-panel)] p-5 max-w-xl w-full">
    <h2 class="text-lg font-bold mb-2">
      {{ headline }}
    </h2>
    <p class="text-sm text-[var(--text-secondary)] mb-4">
      {{ description }}
    </p>

    <div v-if="invalidMessage" class="text-sm rounded-lg border border-[var(--status-warning-border)] bg-[var(--status-warning-bg)] text-[var(--status-warning-fg)] p-3 mb-4">
      {{ invalidMessage }}
    </div>

    <!-- 经校验的只读快照 -->
    <div v-if="state" class="mb-4">
      <p class="text-sm mb-2 text-[var(--text-secondary)]">
        当前存档快照（只读）：
      </p>
      <dl class="grid grid-cols-2 gap-2 text-sm">
        <dt class="text-[var(--text-muted)]">
          阶段
        </dt>
        <dd>{{ state.phase.kind === 'finished' ? '已结束' : state.phase.kind === 'opening-color' ? '等待选色' : state.phase.kind === 'after-draw' ? '抽牌后决定' : '回合中' }}</dd>
        <dt class="text-[var(--text-muted)]">
          步数
        </dt>
        <dd>{{ state.revision }}</dd>
        <dt class="text-[var(--text-muted)]">
          你的手牌
        </dt>
        <dd>{{ state.players[0]?.hand.length ?? 0 }} 张</dd>
        <template v-if="state.phase.kind === 'finished'">
          <dt class="text-[var(--text-muted)]">
            结果
          </dt>
          <dd>{{ finishedText }}</dd>
        </template>
      </dl>
    </div>
    <p v-else-if="!invalidMessage" class="text-sm text-[var(--text-muted)] mb-4">
      本浏览器还没有可显示的对局存档。
    </p>

    <div class="flex gap-2 flex-wrap">
      <button
        v-if="mode === 'locked'"
        type="button"
        class="min-h-11 px-5 rounded-lg bg-[var(--accent-primary)] text-[var(--accent-contrast)] font-semibold hover:bg-[var(--accent-primary-hover)]"
        @click="emit('takeControl')"
      >
        在此页继续
      </button>
      <button
        v-if="mode === 'no-lock'"
        type="button"
        class="min-h-11 px-5 rounded-lg bg-[var(--accent-primary)] text-[var(--accent-contrast)] font-semibold hover:bg-[var(--accent-primary-hover)]"
        @click="emit('startTemp')"
      >
        开始临时对局（不保存）
      </button>
    </div>
  </div>
</template>
