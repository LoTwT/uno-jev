<script setup lang="ts">
/**
 * Jev 设置对话框：凭据来源选择与个人 Key 的输入 / 显示 / 替换 / 删除。
 *
 * - 默认使用站点额度；选择个人 Key 后三位 Jev 对手都使用该 Key，
 *   费用由用户自己的 TypeSafe 账户承担。
 * - 输入框默认隐藏 Key 内容；保存只校验形状，不发起任何收费的验证请求。
 * - 默认只在页面内存中保留；勾选"在此设备记住"才保存到独立本地存储项。
 *   写入 / 清除失败时准确区分"本页已生效"与"持久化结果"（旧副本是否残留），
 *   并提供重试；存储不可用时退回内存模式并提示。
 * - 键盘交互：打开时焦点进入弹窗、Tab 循环、Escape 关闭、关闭后焦点恢复，
 *   期间背景不可交互（见 useModalDialog）。
 */
import type { AiCredentialSource } from '#shared/ai/protocol'
import type { JevKeyPersistProblem } from '~/composables/useJevCredentials'
import { computed, ref, watch } from 'vue'
import { TYPESAFE_KEYS_URL, validatePersonalKeyShape } from '~/composables/useJevCredentials'
import { useModalDialog } from '~/composables/useModalDialog'

const props = defineProps<{
  source: AiCredentialSource
  hasKey: boolean
  rememberKey: boolean
  storageUnavailable: boolean
  /** 可重试的持久化问题（写入 / 清除失败，区别于存储不可用）。 */
  persistProblem?: JevKeyPersistProblem | null
}>()

const emit = defineEmits<{
  (e: 'setSource', source: AiCredentialSource): void
  (e: 'saveKey', key: string): void
  (e: 'setRemember', enabled: boolean): void
  (e: 'deleteKey'): void
  (e: 'retryPersist'): void
}>()

const open = defineModel<boolean>({ default: false })

const keyDraft = ref('')
const showKey = ref(false)
const keyError = ref<string | null>(null)
/** 弹窗面板（焦点入口与 Tab 循环范围）。 */
const containerRef = ref<HTMLElement | null>(null)

useModalDialog(open, containerRef)

// 已配置的 Key 被删除 / 替换后同步清理草稿与错误提示
watch(() => props.hasKey, () => {
  keyDraft.value = ''
  keyError.value = null
})
watch(open, (now) => {
  if (now) {
    keyDraft.value = ''
    keyError.value = null
    showKey.value = false
  }
})

const sourceLabel = computed(() => (props.source === 'personal' ? '你自己的 Key' : '站点额度'))

/**
 * 持久化问题的准确文案：不宣称已删除或只剩内存副本，说明刷新后的实际结果；
 * 读取失败时结果未知（副本可能仍在），外部新 Key 冲突时说明未受影响。
 */
const persistProblemText = computed(() => {
  const problem = props.persistProblem
  if (problem === null || problem === undefined) {
    return null
  }
  switch (problem.kind) {
    case 'save-failed':
      return problem.staleCopyRemains
        ? '新 Key 已在本页生效，但写入本地存储失败；此前的已记住副本仍未清除，刷新后会恢复并使用旧 Key。'
        : '新 Key 已在本页生效，但写入本地存储失败；刷新后需重新输入。'
    case 'remove-failed':
      return '本页已清除，但删除本地存储中的副本失败；刷新后该 Key 仍会被恢复。'
    case 'storage-error':
      if (problem.op === 'save') {
        return problem.staleCopyPossible
          ? '新 Key 已在本页生效，但无法访问本地存储完成保存；此前的已记住副本可能仍在，刷新后会恢复旧 Key。'
          : '新 Key 已在本页生效，但无法访问本地存储完成保存；保存结果未知，刷新后可能需要重新输入。'
      }
      return problem.op === 'delete'
        ? '本页已删除，但无法访问本地存储确认结果；已记住的副本可能仍在，刷新后该 Key 仍会被恢复。'
        : '本页已取消记住，但无法访问本地存储确认结果；已记住的副本可能仍在，刷新后该 Key 仍会被恢复。'
    case 'conflict':
      return problem.op === 'delete'
        ? '另一标签页保存了新的 Key；本页已删除旧 Key，该新 Key 的已记住副本未受影响。'
        : '另一标签页保存了新的 Key；本页已取消记住，该新 Key 的已记住副本未受影响。'
  }
  // switch 已按判别联合穷尽；此处仅为类型收尾
  return null
})

/** 可重试的问题才提供入口；冲突没有可重试的动作（重试会误删另一页的新 Key）。 */
const persistRetryLabel = computed(() => {
  const problem = props.persistProblem
  if (problem === null || problem === undefined || problem.kind === 'conflict') {
    return null
  }
  if (problem.kind === 'save-failed' || (problem.kind === 'storage-error' && problem.op === 'save')) {
    return '重试保存'
  }
  return '重试清除'
})

function selectSource(source: AiCredentialSource) {
  emit('setSource', source)
}

function submitKey() {
  const result = validatePersonalKeyShape(keyDraft.value)
  if (!result.ok) {
    keyError.value = result.message
    return
  }
  keyError.value = null
  emit('saveKey', keyDraft.value.trim())
  keyDraft.value = ''
  showKey.value = false
}

function toggleRemember(event: Event) {
  emit('setRemember', (event.target as HTMLInputElement).checked)
}

function removeKey() {
  keyDraft.value = ''
  keyError.value = null
  emit('deleteKey')
}
</script>

<template>
  <Teleport to="body">
    <Transition name="game-fade">
      <div
        v-if="open"
        class="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-4"
        @click.self="open = false"
      >
        <div
          ref="containerRef"
          class="w-full sm:max-w-lg max-h-[85dvh] overflow-y-auto rounded-2xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5 shadow-lg focus:outline-none"
          role="dialog"
          aria-modal="true"
          aria-label="Jev 设置"
          tabindex="-1"
        >
          <div class="flex items-center justify-between mb-3">
            <h2 class="text-lg font-bold">
              Jev 设置
            </h2>
            <button
              type="button"
              class="min-h-11 min-w-11 px-3 rounded-lg border border-[var(--border-default)] hover:bg-[var(--surface-subtle)]"
              aria-label="关闭 Jev 设置"
              @click="open = false"
            >
              ✕
            </button>
          </div>

          <p class="text-xs rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-subtle)] px-2.5 py-1.5 mb-4">
            当前使用的来源：<strong>{{ sourceLabel }}</strong>
          </p>

          <!-- 来源选择 -->
          <fieldset class="mb-4">
            <legend class="text-sm font-semibold mb-2">
              Jev 决策的调用凭据
            </legend>
            <div class="space-y-2">
              <label
                class="flex items-start gap-2.5 rounded-xl border p-3 cursor-pointer min-h-11"
                :class="source === 'site' ? 'border-[var(--accent-primary)] bg-[var(--accent-soft)]' : 'border-[var(--border-default)]'"
              >
                <input
                  type="radio"
                  name="jev-credential-source"
                  value="site"
                  class="mt-1"
                  :checked="source === 'site'"
                  @change="selectSource('site')"
                >
                <span class="text-sm">
                  <span class="font-medium">使用站点额度</span>
                  <span class="block text-xs text-[var(--text-secondary)] mt-0.5">默认方式：由本站的 TypeSafe 密钥调用，额度由站点承担。</span>
                </span>
              </label>
              <label
                class="flex items-start gap-2.5 rounded-xl border p-3 cursor-pointer min-h-11"
                :class="source === 'personal' ? 'border-[var(--accent-primary)] bg-[var(--accent-soft)]' : 'border-[var(--border-default)]'"
              >
                <input
                  type="radio"
                  name="jev-credential-source"
                  value="personal"
                  class="mt-1"
                  :checked="source === 'personal'"
                  @change="selectSource('personal')"
                >
                <span class="text-sm">
                  <span class="font-medium">使用自己的 Key</span>
                  <span class="block text-xs text-[var(--text-secondary)] mt-0.5">三位 Jev 对手都使用该 Key，调用费用由你自己的 TypeSafe 账户承担。</span>
                </span>
              </label>
            </div>
          </fieldset>

          <!-- 个人 Key 管理 -->
          <div class="mb-4">
            <h3 class="text-sm font-semibold mb-2">
              个人 API Key
            </h3>
            <p v-if="hasKey" class="text-xs text-[var(--text-secondary)] mb-2">
              已配置个人 Key（内容已隐藏）。输入新值可替换；删除后回到使用站点额度。
            </p>
            <p v-else class="text-xs text-[var(--text-secondary)] mb-2">
              尚未配置。从
              <a
                :href="TYPESAFE_KEYS_URL"
                target="_blank"
                rel="noopener noreferrer"
                class="underline text-[var(--text-accent)]"
              >TypeSafe 官方控制台</a>
              获取你的 API Key。
            </p>

            <div class="flex gap-2">
              <input
                v-model="keyDraft"
                :type="showKey ? 'text' : 'password'"
                class="flex-1 min-w-0 min-h-11 px-3 rounded-lg border border-[var(--border-default)] bg-[var(--surface-canvas)] text-sm"
                :class="keyError ? 'border-[var(--status-danger-border)]' : ''"
                autocomplete="off"
                autocapitalize="off"
                spellcheck="false"
                :aria-label="hasKey ? '输入新的 API Key 以替换' : '输入你的 TypeSafe API Key'"
                :placeholder="hasKey ? '输入新 Key 以替换（留空保持不变）' : '粘贴你的 TypeSafe API Key'"
                @input="keyError = null"
                @keydown.enter.prevent="submitKey"
              >
              <button
                type="button"
                class="min-h-11 px-3 rounded-lg border border-[var(--border-default)] text-xs whitespace-nowrap"
                :aria-pressed="showKey"
                @click="showKey = !showKey"
              >
                {{ showKey ? '隐藏' : '显示' }}
              </button>
            </div>
            <p v-if="keyError" class="text-xs text-[var(--status-danger-fg)] mt-1.5" role="alert">
              {{ keyError }}
            </p>

            <div class="flex flex-wrap gap-2 mt-2.5">
              <button
                type="button"
                class="min-h-11 px-4 rounded-lg bg-[var(--accent-primary)] text-[var(--accent-contrast)] text-sm font-semibold hover:bg-[var(--accent-primary-hover)] disabled:opacity-50 disabled:cursor-not-allowed"
                :disabled="keyDraft.trim().length === 0"
                @click="submitKey"
              >
                {{ hasKey ? '替换 Key' : '保存 Key' }}
              </button>
              <button
                v-if="hasKey"
                type="button"
                class="min-h-11 px-4 rounded-lg border-2 border-[var(--border-strong)] text-sm font-medium hover:bg-[var(--surface-subtle)]"
                @click="removeKey"
              >
                删除 Key
              </button>
            </div>
            <p class="text-xs text-[var(--text-muted)] mt-2">
              保存只校验格式，不会预先发起收费的验证请求；Key 在下一次 Jev 决策时使用。
            </p>
          </div>

          <!-- 记住与存储说明 -->
          <div class="mb-4">
            <label class="flex items-start gap-2.5 rounded-xl border border-[var(--border-default)] p-3 cursor-pointer min-h-11">
              <input
                type="checkbox"
                class="mt-1"
                :checked="rememberKey"
                @change="toggleRemember"
              >
              <span class="text-sm">
                <span class="font-medium">在此设备记住</span>
                <span class="block text-xs text-[var(--text-secondary)] mt-0.5">
                  默认只在当前页面内存中保留，刷新后需重新输入。勾选后保存到当前浏览器的独立本地存储（不加密，不能视为绝对安全）；不会保存到本站服务器，但调用时会经本站服务端转发到 TypeSafe。
                </span>
              </span>
            </label>
            <p
              v-if="persistProblemText"
              class="text-xs rounded-lg border border-[var(--status-warning-border)] bg-[var(--status-warning-bg)] text-[var(--status-warning-fg)] p-2 mt-2 flex flex-wrap items-center gap-2"
              role="alert"
            >
              <span>{{ persistProblemText }}</span>
              <button
                v-if="persistRetryLabel"
                type="button"
                class="underline font-medium min-h-8 px-1 whitespace-nowrap"
                @click="emit('retryPersist')"
              >
                {{ persistRetryLabel }}
              </button>
            </p>
            <!-- 存储不可用的"仅内存"提示仅在无更具体问题时显示，避免与
                 "副本可能仍在、刷新会恢复"等说明自相矛盾 -->
            <p
              v-if="storageUnavailable && !persistProblemText"
              class="text-xs rounded-lg border border-[var(--status-warning-border)] bg-[var(--status-warning-bg)] text-[var(--status-warning-fg)] p-2 mt-2"
              role="status"
            >
              此浏览器不允许本地保存，Key 仅在本页内存中保留（刷新后需重新输入）。
            </p>
          </div>

          <button
            type="button"
            class="w-full min-h-11 rounded-lg border-2 border-[var(--border-strong)] font-medium hover:bg-[var(--surface-subtle)]"
            @click="open = false"
          >
            完成
          </button>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
