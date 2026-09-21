import type { Ref } from 'vue'
/**
 * 模态弹窗键盘交互：打开时焦点进入弹窗、Tab / Shift+Tab 在弹窗内循环、
 * Escape 关闭、关闭后焦点恢复到触发元素；打开期间用原生 inert 属性让
 * 背景（应用根节点与其他弹窗）不可交互。不引入任何依赖。
 */
import { nextTick, onBeforeUnmount, watch } from 'vue'

/** body 直接子节点中不需要 inert 的非交互元素。 */
const NON_INTERACTIVE_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'TITLE', 'NOSCRIPT', 'TEMPLATE'])

export function useModalDialog(open: Ref<boolean>, containerRef: Ref<HTMLElement | null>) {
  let previouslyFocused: HTMLElement | null = null
  let active = false

  /** 弹窗内可聚焦元素（按文档顺序）。 */
  function focusableElements(): HTMLElement[] {
    const container = containerRef.value
    if (!container) {
      return []
    }
    return [...container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )]
  }

  /**
   * 把弹窗以外的 body 直接子树置为 inert（含应用根节点与其他弹窗传送门）；
   * 弹窗自身所在的子树除外。Teleport 被 stub（内容就地渲染）时宿主子树
   * 包含弹窗，会被跳过，不会误伤。
   */
  function setBackgroundInert(inert: boolean) {
    const container = containerRef.value
    if (!container) {
      return
    }
    for (const element of Array.from(document.body.children)) {
      if (!(element instanceof HTMLElement) || NON_INTERACTIVE_TAGS.has(element.tagName)) {
        continue
      }
      if (element.contains(container) || container.contains(element)) {
        continue
      }
      element.inert = inert
    }
  }

  function onKeyDown(event: KeyboardEvent) {
    if (!active) {
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      open.value = false
      return
    }
    if (event.key !== 'Tab') {
      return
    }
    const container = containerRef.value
    if (!container) {
      return
    }
    const items = focusableElements()
    if (items.length === 0) {
      event.preventDefault()
      container.focus()
      return
    }
    const first = items[0]!
    const last = items[items.length - 1]!
    const current = document.activeElement
    const inside = current instanceof HTMLElement && container.contains(current)
    if (event.shiftKey) {
      // Shift+Tab：从第一个（或焦点已逸出弹窗）绕回最后一个
      if (!inside || current === first || current === container) {
        event.preventDefault()
        last.focus()
      }
    }
    else if (!inside || current === last) {
      // Tab：从最后一个（或焦点已逸出弹窗）绕回第一个
      event.preventDefault()
      first.focus()
    }
  }

  async function enter() {
    active = true
    // 记录触发入口（此时焦点仍在背景）
    previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    document.addEventListener('keydown', onKeyDown, true)
    await nextTick()
    if (!active || !open.value) {
      return
    }
    setBackgroundInert(true)
    containerRef.value?.focus()
  }

  function leave() {
    if (!active) {
      return
    }
    active = false
    document.removeEventListener('keydown', onKeyDown, true)
    setBackgroundInert(false)
    const target = previouslyFocused
    previouslyFocused = null
    if (target && target.isConnected) {
      target.focus()
    }
  }

  watch(open, (now) => {
    if (now) {
      void enter()
    }
    else {
      leave()
    }
  }, { immediate: true })

  onBeforeUnmount(leave)
}
