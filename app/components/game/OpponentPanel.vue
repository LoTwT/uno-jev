<script setup lang="ts">
/**
 * 对手座位：暗牌 / 明牌、UNO 状态、思考中标识与决策来源。
 * 兜底标识在对手状态区持续可见，不能只闪现一次 toast。
 */
import type { PublicEvent } from '#shared/game'
import type { OpponentView } from '~/composables/useUnoGame'
import { computed } from 'vue'
import { getCard } from '#shared/game'
import { fallbackReasonText, sourceBadgeText } from '~/utils/display'

const props = defineProps<{
  opponent: OpponentView
  isCurrent: boolean
  thinking: boolean
  position: 'left' | 'top' | 'right'
  revealHands: boolean
  lastPlay: Extract<PublicEvent, { type: 'card-played' }> | null
}>()

const visibleCards = computed(() => props.revealHands
  ? props.opponent.player.hand.map(id => getCard(id)!)
  : [])
const cardBackCount = computed(() => Math.min(props.opponent.player.hand.length, 7))
const positionLabel = computed(() => ({ left: '左手', top: '对家', right: '右手' }[props.position]))
</script>

<template>
  <section
    class="opponent-seat rounded-xl border p-1.5 sm:p-3 min-w-0"
    :class="[
      position === 'top' ? 'opponent-seat-top' : '',
      isCurrent
        ? 'border-[var(--accent-primary)] bg-[var(--accent-soft)]'
        : 'border-transparent bg-[var(--surface-panel)]',
    ]"
    :aria-label="`${opponent.player.name}，剩 ${opponent.player.hand.length} 张牌`"
  >
    <div class="seat-position flex items-center justify-between gap-1 min-w-0 mb-1">
      <span class="text-[10px] sm:text-xs text-[var(--text-muted)]">{{ positionLabel }}</span>
      <span v-if="isCurrent" class="text-[10px] font-semibold text-[var(--accent-primary)]">行动中</span>
    </div>
    <div class="seat-name flex items-center justify-between gap-1 min-w-0 flex-wrap">
      <span class="font-semibold text-sm truncate">{{ opponent.player.name }}</span>
      <span class="text-xs text-[var(--text-secondary)]">{{ opponent.player.hand.length }} 张</span>
      <span
        v-if="opponent.player.unoDeclared"
        class="font-bold text-[var(--status-danger-fg)]"
      >UNO!</span>
    </div>

    <!-- 明牌仅改变本地展示；关闭时不渲染对手牌面与牌面标签。 -->
    <div
      v-if="revealHands && visibleCards.length"
      class="opponent-hand mt-2 rounded-md focus-visible:outline-2 focus-visible:outline-[var(--accent-primary)]"
      role="group"
      tabindex="0"
      :aria-label="`${opponent.player.name} 的明牌手牌，共 ${visibleCards.length} 张，可滚动查看`"
    >
      <GameCard v-for="card in visibleCards" :key="card.id" :card="card" size="sm" />
    </div>
    <div v-else-if="!revealHands && cardBackCount" class="card-fan" aria-hidden="true">
      <div
        v-for="index in cardBackCount"
        :key="index"
        class="card-back uno-card-back"
        :style="{ transform: `rotate(${(index - (cardBackCount + 1) / 2) * 5}deg)` }"
      >
        <span>J</span>
      </div>
    </div>

    <div v-if="thinking || opponent.lastSource" class="seat-source mt-1.5 min-h-5">
      <span
        v-if="thinking"
        class="text-[10px] sm:text-xs text-[var(--text-secondary)]"
      >思考中…</span>
      <span
        v-else-if="opponent.lastSource === 'fallback'"
        class="text-[10px] sm:text-xs text-[var(--status-warning-fg)] inline-block max-w-full"
        :title="opponent.lastFallbackReason ? fallbackReasonText(opponent.lastFallbackReason) : undefined"
      >本次使用规则策略</span>
      <span
        v-else-if="opponent.lastSource"
        class="text-[10px] sm:text-xs text-[var(--text-muted)]"
      >{{ sourceBadgeText(opponent.lastSource) }}</span>
    </div>
    <div class="seat-play mt-2 pt-2 border-t border-[var(--border-subtle)]">
      <SeatPlay :play="lastPlay" />
    </div>
  </section>
</template>

<style scoped>
.opponent-seat {
  transition: background-color 180ms ease, border-color 180ms ease;
}

.opponent-seat-top {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  column-gap: 0.75rem;
}

.opponent-seat-top .seat-position,
.opponent-seat-top .seat-name {
  grid-column: 1;
}

.opponent-seat-top .opponent-hand,
.opponent-seat-top .card-fan,
.opponent-seat-top .seat-source {
  grid-column: 1 / -1;
}

.opponent-seat-top .seat-play {
  grid-area: 1 / 2 / 3 / 3;
  align-self: center;
  margin: 0;
  padding: 0 0 0 0.75rem;
  border-top: 0;
  border-left: 1px solid var(--border-subtle);
}

.opponent-hand {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(2rem, 1fr));
  justify-items: center;
  gap: 0.25rem;
  max-height: 6.5rem;
  overflow: auto;
  scrollbar-width: thin;
  overscroll-behavior: contain;
  padding: 0.125rem;
}

.card-fan {
  display: flex;
  justify-content: center;
  padding: 0.625rem 0 0.25rem;
}

.card-back {
  display: grid;
  place-items: center;
  width: 1.375rem;
  height: 2rem;
  flex-shrink: 0;
  border: 1px solid var(--border-strong);
  border-radius: 0.25rem;
  font-size: 0.625rem;
  font-weight: 700;
  transform-origin: center bottom;
}

.card-back + .card-back {
  margin-left: -0.875rem;
}

@media (min-width: 640px) {
  .opponent-hand {
    grid-template-columns: repeat(auto-fill, minmax(2.5rem, 1fr));
    max-height: 7.75rem;
  }

  .card-back {
    width: 1.875rem;
    height: 2.625rem;
  }
}

:global(html[data-reduced-motion='true'] .opponent-seat) {
  transition: none;
}

@media (prefers-reduced-motion: reduce) {
  .opponent-seat {
    transition: none;
  }
}
</style>
