<script setup lang="ts">
/**
 * 对手摘要：牌背数量、UNO 状态、思考中标识与决策来源。
 * 兜底标识在对手状态区持续可见，不能只闪现一次 toast。
 */
import type { OpponentView } from '~/composables/useUnoGame'
import { fallbackReasonText, sourceBadgeText } from '~/utils/display'

defineProps<{
  opponent: OpponentView
  isCurrent: boolean
  thinking: boolean
}>()
</script>

<template>
  <div
    class="rounded-xl border p-3 min-w-0 flex-1"
    :class="[
      isCurrent
        ? 'border-[var(--accent-primary)] bg-[var(--accent-soft)]'
        : 'border-[var(--border-default)] bg-[var(--surface-panel)]',
    ]"
    :aria-label="`${opponent.player.name}，剩 ${opponent.player.hand.length} 张牌`"
  >
    <div class="flex items-center justify-between gap-2 min-w-0">
      <span class="font-semibold text-sm truncate">{{ opponent.player.name }}</span>
      <span
        v-if="isCurrent"
        class="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--accent-primary)] text-[var(--accent-contrast)] shrink-0"
        :aria-hidden="true"
      >行动中</span>
    </div>
    <div class="mt-1.5 text-xs text-[var(--text-secondary)] flex items-center gap-1 flex-wrap">
      <span aria-hidden="true">🂠</span>
      <span>{{ opponent.player.hand.length }} 张</span>
      <span
        v-if="opponent.player.unoDeclared"
        class="font-bold text-[var(--status-danger-fg)]"
      >UNO!</span>
    </div>
    <div class="mt-1.5 min-h-5">
      <span
        v-if="thinking"
        class="text-xs animate-pulse text-[var(--text-secondary)]"
      >思考中…</span>
      <span
        v-else-if="opponent.lastSource === 'fallback'"
        class="text-xs text-[var(--status-warning-fg)] inline-block max-w-full truncate"
        :title="opponent.lastFallbackReason ? fallbackReasonText(opponent.lastFallbackReason) : undefined"
      >本次使用规则策略{{ opponent.lastFallbackReason ? `（${fallbackReasonText(opponent.lastFallbackReason)}）` : '' }}</span>
      <span
        v-else-if="opponent.lastSource"
        class="text-xs text-[var(--text-muted)]"
      >{{ sourceBadgeText(opponent.lastSource) }}</span>
    </div>
  </div>
</template>
