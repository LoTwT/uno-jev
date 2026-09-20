<script setup lang="ts">
/** 四人牌桌只负责空间布局与展示，真人操作由页面插槽提供。 */
import type { Card, GameState, PlayerId, PublicEvent } from '#shared/game'
import type { OpponentView } from '~/composables/useUnoGame'
import { computed } from 'vue'

const props = defineProps<{
  state: GameState
  opponents: OpponentView[]
  topCard: Card | null
  thinkingActorId: PlayerId | null
  revealHands: boolean
}>()

const emit = defineEmits<{
  (e: 'setRevealHands', enabled: boolean): void
}>()

type CardPlayedEvent = Extract<PublicEvent, { type: 'card-played' }>

// direction=1 从本方走向左手，再到对家、右手；反转不改变物理座位。
const seatPositions = {
  p1: 'left',
  p2: 'top',
  p3: 'right',
} as const

const opponentSeats = computed(() => props.opponents.map(opponent => ({
  opponent,
  position: seatPositions[opponent.player.id as keyof typeof seatPositions],
})))

const lastPlays = computed(() => {
  const plays: Partial<Record<PlayerId, CardPlayedEvent>> = {}
  for (const event of props.state.recentEvents) {
    if (event.type === 'card-played') {
      plays[event.playerId] = event
    }
  }
  return plays
})

const topCardPlay = computed(() => {
  const event = props.state.recentEvents.findLast(event => event.type === 'card-played')
  return event?.type === 'card-played' && event.cardId === props.topCard?.id ? event : null
})
const lastPlayedBy = computed(() => props.state.players.find(player => player.id === topCardPlay.value?.playerId)?.name ?? null)
const humanPlayer = computed(() => props.state.players[0]!)
const humanIsCurrent = computed(() => props.state.currentPlayerId === 'p0' && props.state.phase.kind !== 'finished')
</script>

<template>
  <section aria-label="四人牌桌" class="min-w-0">
    <div class="flex items-center justify-between gap-3 mb-3">
      <div>
        <h2 class="text-sm font-semibold">
          四人牌桌
        </h2>
        <p class="text-xs text-[var(--text-muted)] mt-1">
          {{ revealHands ? '对手手牌已公开，可滚动查看' : '你在下方，按座次轮流出牌' }}
        </p>
      </div>
      <button
        type="button"
        class="min-h-11 px-3 rounded-lg border text-xs shrink-0 flex items-center gap-2"
        :class="revealHands
          ? 'border-[var(--accent-primary)] bg-[var(--accent-soft)] text-[var(--accent-primary)]'
          : 'border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--surface-subtle)]'"
        :aria-pressed="revealHands"
        aria-label="明牌模式"
        @click="emit('setRevealHands', !revealHands)"
      >
        <span>明牌模式</span>
        <span class="font-semibold">{{ revealHands ? '开' : '关' }}</span>
      </button>
    </div>

    <div class="table-surface">
      <OpponentPanel
        v-for="seat in opponentSeats"
        :key="seat.opponent.player.id"
        class="table-seat"
        :class="`table-seat-${seat.position}`"
        :data-seat="seat.opponent.player.id"
        :opponent="seat.opponent"
        :position="seat.position"
        :is-current="state.currentPlayerId === seat.opponent.player.id && state.phase.kind !== 'finished'"
        :thinking="thinkingActorId === seat.opponent.player.id"
        :reveal-hands="revealHands"
        :last-play="lastPlays[seat.opponent.player.id] ?? null"
      />

      <TableCenter
        class="table-center"
        :top-card="topCard"
        :current-color="state.currentColor"
        :direction="state.direction"
        :draw-pile-count="state.drawPile.length"
        :last-played-by="lastPlayedBy"
        :last-player-id="topCardPlay?.playerId ?? null"
      />

      <div
        class="human-seat table-seat"
        :class="humanIsCurrent ? 'border-[var(--accent-primary)]' : 'border-[var(--border-default)]'"
        data-seat="p0"
        aria-label="你的座位"
      >
        <div class="flex items-center justify-between gap-3 mb-2">
          <div class="flex items-center gap-2 flex-wrap">
            <h3 class="text-sm font-semibold">
              你
            </h3>
            <span class="text-xs text-[var(--text-muted)]">本方 · {{ humanPlayer.hand.length }} 张</span>
            <span v-if="humanIsCurrent" class="text-xs font-semibold text-[var(--accent-primary)]">轮到你了</span>
            <span v-if="humanPlayer.unoDeclared" class="text-xs font-bold text-[var(--status-danger-fg)]">UNO!</span>
          </div>
          <SeatPlay :play="lastPlays.p0 ?? null" compact />
        </div>
        <slot />
      </div>
    </div>
  </section>
</template>

<style scoped>
.table-surface {
  position: relative;
  isolation: isolate;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.35fr) minmax(0, 1fr);
  align-items: center;
  gap: 0.75rem 0.5rem;
  padding: 0.5rem;
  border: 1px solid var(--border-subtle);
  border-radius: 1.5rem;
  background: var(--surface-subtle);
}

.table-surface::before {
  content: '';
  position: absolute;
  z-index: -1;
  inset: 7% 5% 25%;
  border: 1px solid var(--border-default);
  border-radius: 50%;
  background: var(--surface-canvas);
}

.table-seat {
  min-width: 0;
}

.table-seat-top {
  grid-area: 1 / 1 / 2 / -1;
  justify-self: center;
  width: min(100%, 36rem);
}

.table-seat-left {
  grid-area: 2 / 1;
}

.table-seat-right {
  grid-area: 2 / 3;
}

.table-center {
  grid-area: 2 / 2;
  min-width: 0;
}

.human-seat {
  grid-area: 3 / 1 / 4 / -1;
  padding: 0.75rem;
  border-width: 1px;
  border-style: solid;
  border-radius: 1rem;
  background: var(--surface-panel);
}

@media (min-width: 640px) {
  .table-surface {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.65fr) minmax(0, 1fr);
    gap: 1rem;
    padding: 1rem;
    border-radius: 2rem;
  }

  .human-seat {
    padding: 1rem;
  }

  .table-seat-top {
    grid-area: 1 / 2;
  }

  .table-seat-left {
    grid-area: 1 / 1 / 3 / 2;
  }

  .table-seat-right {
    grid-area: 1 / 3 / 3 / 4;
  }
}
</style>
