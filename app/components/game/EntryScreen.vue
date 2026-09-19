<script setup lang="ts">
/**
 * 入口页：新局与有效存档的继续入口；规则摘要明确显示
 * 单局、无叠加、严格 +4、AI 自动抓漏。
 */
import type { GameState } from '#shared/game'

const props = defineProps<{
  hasValidSave: boolean
  savedState: GameState | null
}>()

const emit = defineEmits<{
  (e: 'start'): void
  (e: 'continue'): void
  (e: 'showRules'): void
}>()

const saveSummary = computed(() => {
  if (!props.savedState) {
    return null
  }
  const state = props.savedState
  const phase = state.phase.kind === 'finished'
    ? (state.phase.result.reason === 'empty-hand' ? '已结束（有胜者）' : '已结束（和局）')
    : state.phase.kind === 'opening-color' ? '等待选起始颜色' : state.phase.kind === 'after-draw' ? '抽牌后决定中' : '回合进行中'
  return { phase, revision: state.revision, handCount: state.players[0]?.hand.length ?? 0 }
})
</script>

<template>
  <div class="max-w-xl w-full rounded-2xl border border-[var(--border-default)] bg-[var(--surface-panel)] p-6 sm:p-8">
    <h1 class="text-3xl font-bold mb-1">
      UnoJev
    </h1>
    <p class="text-sm text-[var(--text-secondary)] mb-5">
      与三位 Jev AI 玩一局经典 UNO。对局只保存在你的浏览器里。
    </p>

    <!-- 规则摘要：明确关键取舍 -->
    <div class="mb-6">
      <ul class="text-sm space-y-1.5 text-[var(--text-secondary)]">
        <li>• 单局胜负，先出完手牌者获胜（不计 500 分）</li>
        <li>• 经典规则：+2 / +4 不叠加，严格校验 +4（本版不提供质疑）</li>
        <li>• AI 总会宣告 UNO，也会自动抓到你的漏喊</li>
      </ul>
      <button
        type="button"
        class="mt-2 text-sm underline text-[var(--text-accent)] min-h-9"
        @click="emit('showRules')"
      >
        查看完整规则说明
      </button>
    </div>

    <!-- 有效存档的继续入口 -->
    <div v-if="hasValidSave && saveSummary" class="mb-4">
      <button
        type="button"
        class="w-full min-h-12 px-5 rounded-xl bg-[var(--accent-primary)] text-[var(--accent-contrast)] font-semibold hover:bg-[var(--accent-primary-hover)] transition-colors"
        @click="emit('continue')"
      >
        继续上次对局（{{ saveSummary.phase }}，第 {{ saveSummary.revision }} 步，手牌 {{ saveSummary.handCount }} 张）
      </button>
    </div>

    <button
      type="button"
      class="w-full min-h-12 px-5 rounded-xl border-2 border-[var(--border-strong)] font-semibold hover:bg-[var(--surface-subtle)] transition-colors"
      :class="hasValidSave ? '' : 'bg-[var(--accent-primary)] text-[var(--accent-contrast)] border-transparent hover:bg-[var(--accent-primary-hover)]'"
      @click="emit('start')"
    >
      {{ hasValidSave ? '新开一局（将替换当前存档）' : '开始新对局' }}
    </button>
  </div>
</template>
