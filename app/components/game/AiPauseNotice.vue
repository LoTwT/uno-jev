<script setup lang="ts">
/**
 * Jev 暂停提示：服务端缺少密钥或上游 401/403（503 ai_unavailable）后，
 * 本页面会话暂停 Jev 请求，期间各次 AI 行动使用明确标识的规则策略。
 * "重试 AI"只恢复后续决策，不重放已落地的动作。
 */
defineProps<{
  /** 暂停原因文案（如"AI 暂不可用"），可选。 */
  reason?: string | null
}>()

const emit = defineEmits<{
  (e: 'retry'): void
}>()
</script>

<template>
  <div
    class="text-xs px-3 py-1.5 rounded-lg border border-[var(--status-warning-border)] bg-[var(--status-warning-bg)] text-[var(--status-warning-fg)] flex items-center gap-2 flex-wrap"
    role="status"
    aria-live="polite"
  >
    <span aria-hidden="true">⚠</span>
    <span>Jev 暂时不可用{{ reason ? `（${reason}）` : '' }}，AI 正在使用规则策略继续</span>
    <button
      type="button"
      class="underline font-medium min-h-8 px-1"
      @click="emit('retry')"
    >
      重试 AI
    </button>
  </div>
</template>
