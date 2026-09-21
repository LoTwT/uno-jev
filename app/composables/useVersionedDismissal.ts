import type { Ref } from 'vue'
/**
 * 按版本失效的"提示已确认"状态：确认记录绑定到确认时的版本号。
 *
 * 用于把提示条的关闭状态关联到当前凭据（如个人 Key）版本：同一 Key 的连续
 * 失败不重复打扰（版本未变、已确认则不再显示）；替换或删除 Key 后版本递增，
 * 新 Key 的失败会重新显示原因与修改入口。
 */
import { computed, readonly, ref } from 'vue'

export function useVersionedDismissal(version: Readonly<Ref<number>>) {
  /** 确认时所在的版本；null 表示从未确认。 */
  const dismissedAt = ref<number | null>(null)

  /** 当前版本下是否已确认（版本变化后自动失效）。 */
  const dismissed = computed(() => dismissedAt.value !== null && dismissedAt.value === version.value)

  /** 记录"在当前版本下已确认"。 */
  function dismiss() {
    dismissedAt.value = version.value
  }

  /** 清除确认记录（恢复显示）。 */
  function reset() {
    dismissedAt.value = null
  }

  return { dismissed: readonly(dismissed), dismiss, reset }
}
