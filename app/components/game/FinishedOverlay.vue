<script setup lang="ts">
/**
 * 结束页：给出胜者或和局原因，以及再来一局的操作。
 */
import type { GameState, Player } from '#shared/game'
import { computed } from 'vue'

const props = defineProps<{
  state: GameState
}>()

const emit = defineEmits<{
  (e: 'restart'): void
  (e: 'exit'): void
}>()

const winner = computed<Player | null>(() => {
  const phase = props.state.phase
  if (phase.kind !== 'finished' || phase.result.reason !== 'empty-hand') {
    return null
  }
  return props.state.players.find(p => p.id === phase.result.winnerId) ?? null
})

const headline = computed(() => winner.value
  ? (winner.value.id === 'p0' ? '你赢了！' : `${winner.value.name} 获胜`)
  : '和局')

const detail = computed(() => {
  const phase = props.state.phase
  if (phase.kind !== 'finished') {
    return ''
  }
  if (phase.result.reason === 'empty-hand') {
    return winner.value?.id === 'p0'
      ? '你出完了所有手牌。'
      : `${winner.value?.name ?? ''} 先出完了手牌。`
  }
  return '连续多个回合都无牌可抽，本局按规则结束为和局。'
})
</script>

<template>
  <section
    class="rounded-2xl border-2 border-[var(--accent-primary)] bg-[var(--surface-elevated)] p-6 text-center max-w-md w-full"
    role="alertdialog"
    aria-live="assertive"
    aria-label="对局结果"
  >
    <h2 class="text-2xl font-bold mb-2">
      {{ headline }}
    </h2>
    <p class="text-sm text-[var(--text-secondary)] mb-5">
      {{ detail }}
    </p>
    <div class="flex gap-2 justify-center flex-wrap">
      <button
        type="button"
        class="min-h-11 px-6 rounded-lg bg-[var(--accent-primary)] text-[var(--accent-contrast)] font-semibold hover:bg-[var(--accent-primary-hover)]"
        @click="emit('restart')"
      >
        再来一局
      </button>
      <button
        type="button"
        class="min-h-11 px-6 rounded-lg border-2 border-[var(--border-strong)] hover:bg-[var(--surface-subtle)] font-medium"
        @click="emit('exit')"
      >
        返回入口
      </button>
    </div>
  </section>
</template>
