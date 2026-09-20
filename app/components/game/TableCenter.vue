<script setup lang="ts">
/**
 * 牌桌中心：抽牌堆（数量 + 牌背）、弃牌堆顶牌、当前颜色与方向指示。
 * 当前颜色与方向都有文字，不仅依赖色相。
 */
import type { Card, Color, PlayerId } from '#shared/game'
import { computed } from 'vue'
import { COLOR_NAMES } from '~/utils/display'

const props = defineProps<{
  topCard: Card | null
  currentColor: Color | null
  direction: 1 | -1
  drawPileCount: number
  lastPlayedBy: string | null
  lastPlayerId: PlayerId | null
}>()

const playOrigin = computed(() => ({
  p0: { '--play-x': '0px', '--play-y': '20px' },
  p1: { '--play-x': '-20px', '--play-y': '0px' },
  p2: { '--play-x': '0px', '--play-y': '-20px' },
  p3: { '--play-x': '20px', '--play-y': '0px' },
}[props.lastPlayerId ?? 'p0']))

const colorSwatchClass = computed(() => {
  switch (props.currentColor) {
    case 'red':
      return 'bg-[var(--game-red)]'
    case 'yellow':
      return 'bg-[var(--game-yellow)]'
    case 'green':
      return 'bg-[var(--game-green)]'
    case 'blue':
      return 'bg-[var(--game-blue)]'
    default:
      return 'bg-[var(--surface-muted)]'
  }
})
</script>

<template>
  <div class="flex flex-col items-center justify-center gap-3 sm:gap-4 py-2" aria-label="公共牌堆">
    <div class="flex items-start justify-center gap-2 sm:gap-5">
      <!-- 抽牌堆 -->
      <div class="flex flex-col items-center gap-1.5">
        <div class="relative" aria-hidden="true">
          <div class="absolute inset-0 translate-x-1.5 translate-y-1.5">
            <div class="uno-card uno-card-back pile-size rounded-xl border-2" />
          </div>
          <div class="uno-card uno-card-back pile-size rounded-xl border-2 flex flex-col items-center justify-center">
            <span class="font-bold text-xs sm:text-xl opacity-70">UNO</span>
          </div>
        </div>
        <span class="text-[10px] sm:text-xs text-[var(--text-secondary)]">抽牌 · {{ drawPileCount }} 张</span>
      </div>

      <!-- 弃牌堆顶牌 -->
      <div class="flex flex-col items-center gap-1.5">
        <div class="pile-size flex items-center justify-center" :style="playOrigin">
          <Transition name="table-play" mode="out-in">
            <GameCard
              v-if="topCard"
              :key="topCard.id"
              :card="topCard"
              size="lg"
            />
          </Transition>
        </div>
        <span class="text-[10px] sm:text-xs text-[var(--text-secondary)]">弃牌堆顶</span>
      </div>
    </div>

    <p v-if="lastPlayedBy" class="text-[10px] sm:text-xs text-[var(--text-muted)] text-center">
      {{ lastPlayedBy }} 打出
    </p>

    <!-- 当前颜色与方向 -->
    <div class="flex flex-col items-center gap-2">
      <div class="flex items-center gap-1.5">
        <span
          class="inline-block w-3 h-3 sm:w-4 sm:h-4 rounded-sm border border-[var(--border-strong)] shrink-0"
          :class="colorSwatchClass"
          aria-hidden="true"
        />
        <span class="text-[10px] sm:text-sm font-medium">{{ currentColor ? `当前颜色：${COLOR_NAMES[currentColor]}` : '等待选色' }}</span>
      </div>
      <div class="flex items-center gap-1 text-xs sm:text-sm text-[var(--text-secondary)] whitespace-nowrap">
        <span aria-hidden="true">{{ direction === 1 ? '↻' : '↺' }}</span>
        <span>{{ direction === 1 ? '顺时针' : '逆时针' }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pile-size {
  width: 3rem;
  height: 4.5rem;
}

.table-play-enter-active,
.table-play-leave-active {
  transition: transform 180ms ease, opacity 180ms ease;
}

.table-play-enter-from {
  opacity: 0;
  transform: translate(var(--play-x), var(--play-y)) rotate(-6deg);
}

.table-play-leave-to {
  opacity: 0;
}

@media (min-width: 640px) {
  .pile-size {
    width: 5rem;
    height: 7rem;
  }
}

:global(html[data-reduced-motion='true'] .table-play-enter-active),
:global(html[data-reduced-motion='true'] .table-play-leave-active) {
  transition: none;
}

@media (prefers-reduced-motion: reduce) {
  .table-play-enter-active,
  .table-play-leave-active {
    transition: none;
  }
}
</style>
