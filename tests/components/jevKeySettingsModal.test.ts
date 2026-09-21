// @vitest-environment happy-dom
// K 系（弹窗键盘交互，问题 4）：打开时焦点进入弹窗、Tab / Shift+Tab 在弹窗内循环、
// Escape 关闭、关闭后焦点恢复到触发入口、打开期间背景（弹窗以外的 body 子树）
// 被 inert 不可交互。使用真实 Teleport 挂载到 document.body 验证实际效果。
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import JevKeySettings from '~/components/game/JevKeySettings.vue'

/** 宿主：触发按钮 + 受控的 JevKeySettings（v-model 接线与页面一致）。 */
function mountHost() {
  let openState!: ReturnType<typeof ref<boolean>>
  const host = defineComponent({
    setup() {
      openState = ref(false)
      return () => h('div', { id: 'modal-test-host' }, [
        h('button', { id: 'modal-trigger', type: 'button', onClick: () => { openState.value = true } }, 'Jev 设置'),
        h(JevKeySettings, {
          'modelValue': openState.value,
          'onUpdate:modelValue': (value: boolean) => { openState.value = value },
          'source': 'site',
          'hasKey': false,
          'rememberKey': false,
          'storageUnavailable': false,
        }),
      ])
    },
  })
  const wrapper = mount(host, { attachTo: document.body })
  const setOpen = (value: boolean) => {
    openState.value = value
  }
  return { wrapper, isOpen: () => openState.value, setOpen }
}

async function flush() {
  await nextTick()
  await nextTick()
}

function pressKey(key: 'Escape' | 'Tab', options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options })
  document.dispatchEvent(event)
  return event
}

function panel(): HTMLElement {
  return document.querySelector<HTMLElement>('[role="dialog"]')!
}

function focusables(): HTMLElement[] {
  return [...panel().querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')]
}

/** 弹窗以外的 body 直接子树（挂载宿主等"背景"）；inert 作用于它而不是其内部元素。 */
function backgroundRoot(): HTMLElement {
  const dialog = panel()
  return [...document.body.children].find(element => !element.contains(dialog)) as HTMLElement
}

let cleanup: (() => void) | null = null

afterEach(() => {
  cleanup?.()
  cleanup = null
})

describe('jevKeySettings 弹窗键盘交互（问题 4）', () => {
  it('打开时焦点进入弹窗，背景子树被 inert', async () => {
    const host = mountHost()
    cleanup = () => host.wrapper.unmount()
    const trigger = document.getElementById('modal-trigger') as HTMLButtonElement
    trigger.focus()
    trigger.click()
    await flush()

    expect(host.isOpen()).toBe(true)
    // 焦点进入弹窗面板
    expect(document.activeElement).toBe(panel())
    // 背景不可交互：弹窗以外的 body 直接子树被置为 inert
    expect(backgroundRoot().inert).toBe(true)
  })

  it('按 Escape 关闭弹窗；关闭后背景恢复交互且焦点回到触发入口', async () => {
    const host = mountHost()
    cleanup = () => host.wrapper.unmount()
    const trigger = document.getElementById('modal-trigger') as HTMLButtonElement
    trigger.focus()
    trigger.click()
    await flush()
    expect(host.isOpen()).toBe(true)

    const event = pressKey('Escape')
    expect(event.defaultPrevented).toBe(true)
    await flush()

    expect(host.isOpen()).toBe(false)
    expect(backgroundRoot().inert).toBe(false)
    expect(document.activeElement).toBe(trigger)
  })

  it('按 Tab 在弹窗内循环：从最后一个可聚焦元素绕回第一个', async () => {
    const host = mountHost()
    cleanup = () => host.wrapper.unmount()
    host.setOpen(true)
    await flush()

    const items = focusables()
    expect(items.length).toBeGreaterThan(1)
    const first = items[0]!
    const last = items[items.length - 1]!

    // 焦点在最后一个（完成按钮）上按 Tab → 绕回第一个（关闭按钮）
    last.focus()
    const event = pressKey('Tab')
    expect(event.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(first)
  })

  it('按 Shift+Tab 从第一个可聚焦元素绕回最后一个', async () => {
    const host = mountHost()
    cleanup = () => host.wrapper.unmount()
    host.setOpen(true)
    await flush()

    const items = focusables()
    const first = items[0]!
    const last = items[items.length - 1]!

    first.focus()
    const event = pressKey('Tab', { shiftKey: true })
    expect(event.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(last)
  })

  it('焦点不在弹窗内时按 Tab 被拉回弹窗第一个元素', async () => {
    const host = mountHost()
    cleanup = () => host.wrapper.unmount()
    host.setOpen(true)
    await flush()

    // 模拟焦点逸出弹窗（blur 后 activeElement 为 body，不属于弹窗）
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    const event = pressKey('Tab')
    expect(event.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(focusables()[0])
  })
})
