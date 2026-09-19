<script setup lang="ts">
/**
 * 真人手牌：点选合法牌后确认出牌；非法牌可查看不能出的原因。
 * after-draw 阶段只有刚抽到的牌可出；不可出的牌禁用并朗读原因。
 * 触控目标至少 44×44 CSS px，键盘可完成全部真人动作。
 */
import type { Card } from '#shared/game'
import type { HandCardView } from '~/composables/useUnoGame'
import { cardLabel } from '~/utils/display'

const props = defineProps<{
  cards: HandCardView[]
  /** 是否轮到真人。 */
  active: boolean
  /** 当前选中的牌（正在确认）。 */
  selectedId: string | null
}>()

const emit = defineEmits<{
  (e: 'select', card: Card): void
}>()

function ariaDescription(card: HandCardView): string {
  const parts: string[] = []
  parts.push(card.playable ? '可出' : (card.reason ?? '不可出'))
  if (card.isDrawn) {
    parts.push('刚抽到的牌')
  }
  if (props.selectedId === card.card.id) {
    parts.push('已选中')
  }
  return parts.join('，')
}
</script>

<template>
  <section aria-label="你的手牌">
    <div
      class="hand-scroll flex gap-2 px-2 py-3 -mx-2 items-end"
      role="list"
      :aria-label="`手牌，共 ${cards.length} 张`"
    >
      <div
        v-for="card in cards"
        :key="card.card.id"
        role="listitem"
        class="shrink-0"
      >
        <button
          type="button"
          class="relative rounded-xl p-1 transition-transform"
          :class="[
            selectedId === card.card.id ? 'ring-2 ring-[var(--accent-primary)] -translate-y-2' : '',
            card.playable && active ? 'hover:-translate-y-1 cursor-pointer' : 'opacity-70',
            card.isDrawn ? 'ring-2 ring-[var(--status-success)]' : '',
          ]"
          :disabled="!card.playable"
          :aria-label="`${cardLabel(card.card)}，${ariaDescription(card)}`"
          :aria-pressed="selectedId === card.card.id"
          @click="emit('select', card.card)"
        >
          <GameCard :card="card.card" />
          <span
            v-if="card.isDrawn"
            class="absolute -top-2 -right-1 text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--status-success-bg)] text-[var(--status-success-fg)] border border-[var(--status-success-border)]"
          >刚抽到</span>
        </button>
      </div>
    </div>
  </section>
</template>
