<script setup lang="ts">
/** 座位旁的公开出牌记录；仅作回顾，不是独立的规则牌堆。 */
import type { PublicEvent } from '#shared/game'
import { computed } from 'vue'
import { getCard } from '#shared/game'
import { cardLabel, COLOR_NAMES } from '~/utils/display'

const props = defineProps<{
  play: Extract<PublicEvent, { type: 'card-played' }> | null
  compact?: boolean
}>()

const card = computed(() => props.play ? getCard(props.play.cardId) : null)
</script>

<template>
  <div class="flex items-center justify-center gap-1.5 sm:gap-2 min-w-0" aria-label="最近出牌记录">
    <Transition v-if="!compact" name="game-fade" mode="out-in">
      <GameCard v-if="card" :key="`${play?.revision}-${card.id}`" :card="card" size="sm" class="shrink-0" />
    </Transition>
    <div class="text-[10px] sm:text-xs text-[var(--text-muted)]">
      <p>{{ card ? (compact ? `上次：${cardLabel(card)}` : '上次出牌') : '暂无出牌记录' }}</p>
      <p v-if="play?.chosenColor" class="mt-1 text-[var(--text-secondary)]">
        选{{ COLOR_NAMES[play.chosenColor] }}色
      </p>
    </div>
  </div>
</template>
