<script setup lang="ts">
/**
 * 牌桌中心：抽牌堆（数量 + 牌背）、弃牌堆顶牌、当前颜色与方向指示。
 * 当前颜色与方向都有文字，不仅依赖色相。
 */
import type { Card, Color } from '#shared/game'
import { computed } from 'vue'
import { COLOR_NAMES } from '~/utils/display'

const props = defineProps<{
  topCard: Card | null
  currentColor: Color | null
  direction: 1 | -1
  drawPileCount: number
}>()

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
  <div class="flex items-center justify-center gap-3 sm:gap-10 py-2">
    <!-- 抽牌堆 -->
    <div class="flex flex-col items-center gap-1.5">
      <div class="relative" aria-hidden="true">
        <div class="absolute inset-0 translate-x-1.5 translate-y-1.5">
          <div class="uno-card uno-card-back w-20 h-28 sm:w-24 sm:h-36 rounded-xl border-2" />
        </div>
        <div class="uno-card uno-card-back w-20 h-28 sm:w-24 sm:h-36 rounded-xl border-2 flex flex-col items-center justify-center">
          <span class="font-bold text-xl sm:text-2xl opacity-70">抽牌堆</span>
        </div>
      </div>
      <span class="text-xs text-[var(--text-secondary)]">剩 {{ drawPileCount }} 张</span>
    </div>

    <!-- 弃牌堆顶牌 -->
    <div class="flex flex-col items-center gap-1.5">
      <div class="w-20 h-28 sm:w-24 sm:h-36 flex items-center justify-center">
        <Transition name="game-fade" mode="out-in">
          <GameCard
            v-if="topCard"
            :key="topCard.id"
            :card="topCard"
            size="lg"
          />
        </Transition>
      </div>
      <span class="text-xs text-[var(--text-secondary)]">弃牌堆顶</span>
    </div>

    <!-- 当前颜色与方向 -->
    <div class="flex flex-col items-center gap-2">
      <div class="flex items-center gap-1.5">
        <span
          class="inline-block w-6 h-6 rounded-md border border-[var(--border-strong)]"
          :class="colorSwatchClass"
          aria-hidden="true"
        />
        <span class="text-sm font-medium whitespace-nowrap">{{ currentColor ? `当前颜色：${COLOR_NAMES[currentColor]}` : '等待选色' }}</span>
      </div>
      <div class="flex items-center gap-1 text-sm text-[var(--text-secondary)] whitespace-nowrap">
        <span aria-hidden="true">{{ direction === 1 ? '↻' : '↺' }}</span>
        <span>{{ direction === 1 ? '正向' : '反向' }}</span>
      </div>
    </div>
  </div>
</template>
