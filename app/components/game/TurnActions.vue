<script setup lang="ts">
/**
 * 回合操作：出牌 / UNO 并出牌 / 抽牌 / 保留抽牌。
 * 手牌剩 2 张时清晰呈现普通出牌与"UNO 并出牌"的区别；
 * 按钮禁用时提供原因（无障碍描述）。
 */
import type { Card } from '#shared/game'
import { computed } from 'vue'

const props = defineProps<{
  active: boolean
  /** 选中的牌（可 null）。 */
  selectedCard: Card | null
  /** 选中后是否剩 1 张（可宣告 UNO）。 */
  canDeclareUno: boolean
  /** 当前是否尚未选色（Wild 类已选中但草稿颜色未定）；已选色后为 false。 */
  colorPending: boolean
  /** after-draw 阶段。 */
  afterDraw: boolean
  /** after-draw 的出牌按钮文案。 */
  drawnCard: Card | null
  /** 当前阶段说明。 */
  phaseHint: string
}>()

const emit = defineEmits<{
  (e: 'play', payload: { declareUno: boolean }): void
  (e: 'draw'): void
  (e: 'keepDrawn'): void
}>()

function playDisabledReason(declareUno: boolean): string | null {
  if (!props.active) {
    return '当前不是你的回合'
  }
  if (props.afterDraw) {
    if (!props.drawnCard) {
      return '没有刚抽到的牌'
    }
  }
  else if (!props.selectedCard) {
    return '先在手牌中选择一张牌'
  }
  // 选色是出牌前的草稿：仅在尚未选色时禁用（普通回合与抽后阶段一致）
  if (props.colorPending) {
    return '先为万能牌选择颜色'
  }
  if (declareUno && !props.canDeclareUno) {
    return '只有出到剩 1 张时才能宣告 UNO'
  }
  return null
}

const drawDisabledReason = computed(() => {
  if (!props.active) {
    return '当前不是你的回合'
  }
  if (props.afterDraw) {
    return '抽牌后不能再抽'
  }
  return null
})
</script>

<template>
  <div class="flex flex-col gap-2">
    <p class="text-sm text-[var(--text-secondary)]" role="status">
      {{ phaseHint }}
    </p>
    <div class="flex flex-wrap gap-2 items-center">
      <!-- 出牌确认 -->
      <button
        type="button"
        class="min-h-11 px-5 rounded-lg bg-[var(--accent-primary)] text-[var(--accent-contrast)] font-semibold enabled:hover:bg-[var(--accent-primary-hover)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        :disabled="playDisabledReason(false) !== null"
        :aria-disabled="playDisabledReason(false) !== null"
        :title="playDisabledReason(false) ?? undefined"
        @click="emit('play', { declareUno: false })"
      >
        {{ afterDraw ? '出这张' : (selectedCard ? `出牌` : '出牌') }}
      </button>

      <!-- UNO 并出牌：只在出到剩 1 张时可用 -->
      <button
        v-if="canDeclareUno || selectedCard"
        type="button"
        class="min-h-11 px-5 rounded-lg bg-[var(--status-danger)] text-white font-bold enabled:hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed border-2 border-[var(--status-danger-border)]"
        :disabled="playDisabledReason(true) !== null"
        :aria-disabled="playDisabledReason(true) !== null"
        :title="playDisabledReason(true) ?? undefined"
        @click="emit('play', { declareUno: true })"
      >
        UNO 并出牌
      </button>

      <!-- 抽 1 张（普通回合） -->
      <button
        v-if="!afterDraw"
        type="button"
        class="min-h-11 px-5 rounded-lg border-2 border-[var(--border-strong)] bg-[var(--surface-panel)] font-medium enabled:hover:bg-[var(--surface-elevated)] disabled:opacity-50 disabled:cursor-not-allowed"
        :disabled="drawDisabledReason !== null"
        :aria-disabled="drawDisabledReason !== null"
        :title="drawDisabledReason ?? undefined"
        @click="emit('draw')"
      >
        抽 1 张
      </button>

      <!-- 保留抽牌（after-draw） -->
      <button
        v-else
        type="button"
        class="min-h-11 px-5 rounded-lg border-2 border-[var(--border-strong)] bg-[var(--surface-panel)] font-medium enabled:hover:bg-[var(--surface-elevated)]"
        @click="emit('keepDrawn')"
      >
        保留并结束
      </button>
    </div>
  </div>
</template>
