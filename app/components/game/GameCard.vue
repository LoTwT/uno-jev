<script setup lang="ts">
/**
 * 单张牌面：DOM / CSS 渲染，双主题下都保留清晰数字、功能符号和颜色文字。
 * 纯展示组件；交互（点击、焦点）由父组件的按钮承担。
 */
import type { Card } from '#shared/game'
import { computed } from 'vue'
import { cardLabel, cardSymbol, COLOR_NAMES } from '~/utils/display'

const props = withDefaults(defineProps<{
  card: Card
  faceDown?: boolean
  /** Wild 已选定的颜色提示（顶牌展示当前颜色）。 */
  effectiveColor?: boolean
  size?: 'sm' | 'md' | 'lg'
}>(), {
  faceDown: false,
  effectiveColor: false,
  size: 'md',
})

const colorClass = computed(() => {
  if (props.faceDown) {
    return 'uno-card-back'
  }
  if (props.card.color) {
    return `uno-card-color-${props.card.color}`
  }
  return ''
})

const isWild = computed(() => props.card.kind === 'wild' || props.card.kind === 'wild-draw-four')

const sizeClass = computed(() => ({
  sm: 'w-8 h-12 sm:w-10 sm:h-14',
  md: 'w-[4.5rem] h-[6.5rem]',
  lg: 'w-12 h-[4.5rem] sm:w-20 sm:h-28',
}[props.size]))
const symbolSize = computed(() => ({
  sm: 'text-base sm:text-xl mt-1',
  md: 'text-3xl mt-4',
  lg: 'text-2xl sm:text-4xl mt-2 sm:mt-4',
}[props.size]))
</script>

<template>
  <div
    class="uno-card select-none rounded-xl border-2 flex flex-col items-center justify-center relative shadow-sm"
    :class="[colorClass, sizeClass, isWild && !faceDown ? 'bg-[var(--surface-elevated)] border-[var(--border-strong)] text-[var(--text-primary)]' : 'border-black/10']"
    :aria-label="faceDown ? '牌背' : cardLabel(card)"
  >
    <!-- Wild：四色条表示可选任意颜色 -->
    <template v-if="isWild && !faceDown">
      <div class="absolute flex gap-0.5 rounded-sm overflow-hidden" :class="size === 'sm' ? 'top-1 inset-x-1 h-1' : 'top-2 inset-x-2 h-2'" aria-hidden="true">
        <div class="flex-1" style="background: var(--game-red);" />
        <div class="flex-1" style="background: var(--game-yellow);" />
        <div class="flex-1" style="background: var(--game-green);" />
        <div class="flex-1" style="background: var(--game-blue);" />
      </div>
    </template>

    <template v-if="!faceDown">
      <div class="font-bold leading-none" :class="symbolSize" aria-hidden="true">
        {{ cardSymbol(card) }}
      </div>
      <div class="font-semibold tracking-wide" :class="size === 'sm' ? 'text-[8px] sm:text-[10px] mt-1' : 'text-[10px] sm:text-xs mt-2'">
        {{ card.color ? COLOR_NAMES[card.color] : (card.kind === 'wild' ? '万能' : '万能+4') }}
      </div>
    </template>
    <template v-else>
      <div class="font-bold text-2xl opacity-60" aria-hidden="true">
        UNO
      </div>
      <div class="text-[10px] opacity-60 mt-1">
        Jev
      </div>
    </template>
  </div>
</template>
