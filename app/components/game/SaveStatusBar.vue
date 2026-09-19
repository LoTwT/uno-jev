<script setup lang="ts">
/**
 * 保存状态条：真实反映保存状态，不显示虚假的"已保存"。
 * 失败时提示"本局暂未保存，刷新会丢失新进度"并提供重试 / 仅此页继续。
 */
import type { SaveHealth } from '~/composables/useGamePersistence'

const props = defineProps<{
  health: SaveHealth
}>()

const emit = defineEmits<{
  (e: 'retry'): void
  (e: 'continueInMemory'): void
}>()

const text = computed(() => {
  switch (props.health) {
    case 'ok':
      return '本局已保存'
    case 'failed':
      return '本局暂未保存，刷新会丢失新进度'
    case 'memory-only':
      return '临时对局：仅此页继续，不保存到本地'
    default:
      return ''
  }
})
</script>

<template>
  <div
    class="text-xs px-3 py-1.5 rounded-lg border flex items-center gap-2 flex-wrap"
    :class="[
      health === 'ok'
        ? 'border-[var(--border-subtle)] text-[var(--text-muted)]'
        : health === 'failed'
          ? 'border-[var(--status-warning-border)] bg-[var(--status-warning-bg)] text-[var(--status-warning-fg)]'
          : 'border-[var(--border-default)] text-[var(--text-secondary)]',
    ]"
    role="status"
    :aria-live="health === 'failed' ? 'assertive' : 'polite'"
  >
    <span>{{ health === 'ok' ? '✓' : health === 'failed' ? '⚠' : 'ⓘ' }}</span>
    <span>{{ text }}</span>
    <template v-if="health === 'failed'">
      <button
        type="button"
        class="underline font-medium min-h-8 px-1"
        @click="emit('retry')"
      >
        重试保存
      </button>
      <button
        type="button"
        class="underline font-medium min-h-8 px-1"
        @click="emit('continueInMemory')"
      >
        仅在此页继续
      </button>
    </template>
  </div>
</template>
