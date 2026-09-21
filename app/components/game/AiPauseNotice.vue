<script setup lang="ts">
/**
 * Jev 暂停提示：服务端缺少密钥或站点密钥被上游拒绝（503 ai_unavailable）后，
 * 本页面会话暂停当前来源的 Jev 请求，期间各次 AI 行动使用明确标识的规则策略。
 * "重试 AI"只恢复后续决策，不重放已落地的动作；"配置自己的 Key"打开 Jev 设置。
 */
defineProps<{
  /** 暂停原因文案（如"AI 暂不可用"），可选。 */
  reason?: string | null
}>()

const emit = defineEmits<{
  (e: 'retry'): void
  (e: 'openSettings'): void
}>()
</script>

<template>
  <div
    class="text-xs px-3 py-1.5 rounded-lg border border-[var(--status-warning-border)] bg-[var(--status-warning-bg)] text-[var(--status-warning-fg)] flex items-center gap-2 flex-wrap"
    role="status"
    aria-live="polite"
  >
    <span aria-hidden="true">⚠</span>
    <span>Jev 暂时不可用{{ reason ? `（${reason}）` : '' }}，AI 正在使用规则策略继续；也可以配置自己的 Key</span>
    <button
      type="button"
      class="underline font-medium min-h-8 px-1"
      @click="emit('retry')"
    >
      重试 AI
    </button>
    <button
      type="button"
      class="underline font-medium min-h-8 px-1"
      @click="emit('openSettings')"
    >
      Jev 设置
    </button>
  </div>
</template>
