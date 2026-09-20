<script setup lang="ts">
/**
 * 公开日志：最近事件的中文描述，含 AI 决策来源标记；
 * 兜底标识持续可见，不只闪现一次 toast。
 */
import type { Player, PublicEvent } from '#shared/game'
import { computed } from 'vue'
import { eventDescription } from '~/utils/display'

const props = defineProps<{
  events: PublicEvent[]
  players: Player[]
}>()

const displayed = computed(() => props.events.slice(0, 12))
</script>

<template>
  <section
    class="rounded-xl border border-[var(--border-default)] bg-[var(--surface-panel)] p-3"
    aria-label="对局日志"
  >
    <h2 class="text-sm font-semibold text-[var(--text-secondary)] mb-2">
      最近动作
    </h2>
    <ol
      v-if="displayed.length > 0"
      class="text-sm space-y-1 list-decimal list-inside marker:text-[var(--text-muted)]"
    >
      <li
        v-for="(event, index) in displayed"
        :key="`${event.revision}-${index}`"
        :class="event.type === 'decision-source' && event.source !== 'jev' ? 'text-[var(--status-warning-fg)]' : ''"
      >
        {{ eventDescription(event, players) }}
      </li>
    </ol>
    <p
      v-else
      class="text-sm text-[var(--text-muted)]"
    >
      还没有动作记录
    </p>
  </section>
</template>
