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
  size?: 'md' | 'lg'
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

const sizeClass = computed(() => (props.size === 'lg' ? 'w-20 h-28 sm:w-24 sm:h-36' : 'w-[4.5rem] h-[6.5rem]'))
const symbolSize = computed(() => (props.size === 'lg' ? 'text-4xl sm:text-5xl' : 'text-3xl'))
</script>

<template>
  <div
    class="uno-card select-none rounded-xl border-2 flex flex-col items-center justify-center relative shadow-sm"
    :class="[colorClass, sizeClass, isWild && !faceDown ? 'bg-[var(--surface-elevated)] border-[var(--border-strong)] text-[var(--text-primary)]' : 'border-black/10']"
    :aria-label="faceDown ? '牌背' : cardLabel(card)"
  >
    <!-- Wild：四色条表示可选任意颜色 -->
    <template v-if="isWild && !faceDown">
      <div class="absolute top-2 inset-x-2 flex gap-0.5 rounded-sm overflow-hidden" aria-hidden="true">
        <div class="h-2 flex-1" style="background: var(--game-red);" />
        <div class="h-2 flex-1" style="background: var(--game-yellow);" />
        <div class="h-2 flex-1" style="background: var(--game-green);" />
        <div class="h-2 flex-1" style="background: var(--game-blue);" />
      </div>
    </template>

    <template v-if="!faceDown">
      <div class="font-bold leading-none mt-4" :class="symbolSize" aria-hidden="true">
        {{ cardSymbol(card) }}
      </div>
      <div class="text-xs font-semibold mt-2 tracking-wide">
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
