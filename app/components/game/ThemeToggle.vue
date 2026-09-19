<script setup lang="ts">
/**
 * 主题切换：Paper（浅色）/ Ink（深色）/ 跟随系统。
 * 意图写入 unojev:theme，实际类由 useColorMode 应用。
 */
import type { ThemeIntent } from '~/composables/usePreferences'

defineProps<{
  intent: ThemeIntent
}>()

const emit = defineEmits<{
  (e: 'set', intent: ThemeIntent): void
}>()

const options: Array<{ value: ThemeIntent, label: string }> = [
  { value: 'auto', label: '自动' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
]
</script>

<template>
  <div
    class="inline-flex rounded-lg border border-[var(--border-default)] overflow-hidden"
    role="group"
    aria-label="主题"
  >
    <button
      v-for="option in options"
      :key="option.value"
      type="button"
      class="min-h-11 px-3 text-xs font-medium transition-colors"
      :class="intent === option.value
        ? 'bg-[var(--accent-soft)] text-[var(--text-primary)]'
        : 'text-[var(--text-secondary)] hover:bg-[var(--surface-subtle)]'"
      :aria-pressed="intent === option.value"
      :title="option.value === 'auto' ? '跟随系统' : option.value === 'light' ? 'Paper 浅色' : 'Ink 深色'"
      @click="emit('set', option.value)"
    >
      {{ option.label }}
    </button>
  </div>
</template>
