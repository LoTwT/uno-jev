<script setup lang="ts">
/**
 * 选色面板（Wild 出牌与开局选色共用）：键盘与触控可用，取消不改变状态。
 */
import type { Color } from '#shared/game'
import { COLOR_NAMES } from '~/utils/display'

defineProps<{
  /** 面板用途说明（影响标题与按钮文案）。 */
  purpose?: 'play-wild' | 'opening'
}>()

const emit = defineEmits<{
  (e: 'choose', color: Color): void
  (e: 'cancel'): void
}>()

const colors: Array<{ value: Color, bgClass: string, inkClass: string }> = [
  { value: 'red', bgClass: 'bg-[var(--game-red)]', inkClass: 'text-[var(--game-red-ink)]' },
  { value: 'yellow', bgClass: 'bg-[var(--game-yellow)]', inkClass: 'text-[var(--game-yellow-ink)]' },
  { value: 'green', bgClass: 'bg-[var(--game-green)]', inkClass: 'text-[var(--game-green-ink)]' },
  { value: 'blue', bgClass: 'bg-[var(--game-blue)]', inkClass: 'text-[var(--game-blue-ink)]' },
]
</script>

<template>
  <div
    class="rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-4 shadow-sm"
    role="group"
    :aria-label="purpose === 'opening' ? '选择起始颜色' : '为万能牌选择颜色'"
  >
    <p class="text-sm font-medium mb-3">
      {{ purpose === 'opening' ? '起始牌是万能牌，请选择开局颜色' : '选择要变成的颜色' }}
    </p>
    <div class="grid grid-cols-4 gap-2">
      <button
        v-for="color in colors"
        :key="color.value"
        type="button"
        class="h-16 rounded-lg border-2 border-[var(--border-strong)] transition-transform hover:-translate-y-0.5 min-w-11"
        :class="[color.bgClass, color.inkClass]"
        :aria-label="`选择${COLOR_NAMES[color.value]}色`"
        @click="emit('choose', color.value)"
      >
        <span class="font-bold">{{ COLOR_NAMES[color.value] }}</span>
      </button>
    </div>
    <button
      type="button"
      class="mt-3 text-sm underline text-[var(--text-secondary)] min-h-11"
      @click="emit('cancel')"
    >
      取消
    </button>
  </div>
</template>
