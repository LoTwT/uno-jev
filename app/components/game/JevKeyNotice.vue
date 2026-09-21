<script setup lang="ts">
/**
 * Jev 凭据提示条：持续可见（不随回合重复弹出），直到用户选择操作或切换来源。
 *
 * - quota：站点额度确认耗尽——提供"使用自己的 Key"与"继续使用规则对手"，
 *   以及经核实的 TypeSafe 官方 Key 获取链接；保留当前对局。
 * - rejected：用户自己的 Key 被拒绝（无效或无权限）——问题归属于个人 Key，提供修改入口。
 * - missing：已选择个人 Key 但尚未输入——在此之前 Jev 回合使用规则策略。
 */
import { computed } from 'vue'
import { TYPESAFE_KEYS_URL } from '~/composables/useJevCredentials'

const props = defineProps<{
  variant: 'quota' | 'rejected' | 'missing'
}>()

const emit = defineEmits<{
  (e: 'useOwnKey'): void
  (e: 'dismiss'): void
  (e: 'useSiteQuota'): void
}>()

/** 各提示形态的文案与操作；主操作统一进入 Jev 设置（个人来源）。 */
const NOTICE_CONTENT: Record<typeof props.variant, { title: string, body: string, primary: string, secondary: string }> = {
  quota: {
    title: '站点额度已用完',
    body: '站点提供的 Jev 额度已用完。你可以使用自己的 API Key 继续与 Jev 对战，也可以继续使用规则对手。',
    primary: '使用自己的 Key',
    secondary: '继续使用规则对手',
  },
  rejected: {
    title: '你的 API Key 无法使用',
    body: '你的 API Key 无效或没有权限，Jev 对手暂时使用规则策略。可以在设置中检查或更换 Key。',
    primary: '修改 Key',
    secondary: '继续使用规则对手',
  },
  missing: {
    title: '尚未输入个人 Key',
    body: '已选择使用自己的 Key，但还没有输入 Key。输入之前，Jev 回合将使用规则策略（不会消耗站点额度）。',
    primary: '输入 Key',
    secondary: '改用站点额度',
  },
}

const content = computed(() => NOTICE_CONTENT[props.variant])
</script>

<template>
  <div
    class="text-sm px-3 py-2.5 rounded-xl border border-[var(--status-warning-border)] bg-[var(--status-warning-bg)] text-[var(--status-warning-fg)] flex flex-col gap-2 max-w-3xl mx-auto w-full"
    role="status"
    aria-live="polite"
  >
    <div class="flex items-start gap-2">
      <span aria-hidden="true">⚠</span>
      <p class="font-semibold">
        {{ content.title }}
      </p>
    </div>
    <p class="text-[var(--text-secondary)] leading-relaxed">
      {{ content.body }}
    </p>
    <div class="flex flex-wrap gap-2 items-center">
      <button
        type="button"
        class="min-h-11 px-4 rounded-lg bg-[var(--accent-primary)] text-[var(--accent-contrast)] text-sm font-semibold hover:bg-[var(--accent-primary-hover)]"
        @click="emit('useOwnKey')"
      >
        {{ content.primary }}
      </button>
      <button
        v-if="variant === 'missing'"
        type="button"
        class="min-h-11 px-4 rounded-lg border-2 border-[var(--border-strong)] text-sm font-medium hover:bg-[var(--surface-subtle)]"
        @click="emit('useSiteQuota')"
      >
        {{ content.secondary }}
      </button>
      <button
        v-else
        type="button"
        class="min-h-11 px-4 rounded-lg border-2 border-[var(--border-strong)] text-sm font-medium hover:bg-[var(--surface-subtle)]"
        @click="emit('dismiss')"
      >
        {{ content.secondary }}
      </button>
      <a
        :href="TYPESAFE_KEYS_URL"
        target="_blank"
        rel="noopener noreferrer"
        class="text-xs underline text-[var(--text-accent)] min-h-11 flex items-center"
      >获取 TypeSafe API Key（官方控制台）</a>
    </div>
  </div>
</template>
