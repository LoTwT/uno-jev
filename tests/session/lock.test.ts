// @vitest-environment happy-dom
// S4：Web Locks 多标签页控制——两个"标签页"争用、释放与接管、pagehide 释放、无 Web Locks 时只允许临时对局
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { useGameLock, webLocksSupported } from '~/composables/useGameLock'

interface LockHandle { name: string, mode: string }

/** 简化版 Web Locks API mock：支持 exclusive + ifAvailable。 */
class FakeLockManager {
  private held = false
  private waiters: Array<() => void> = []

  isHeld(): boolean {
    return this.held
  }

  request(name: string, options: { mode: 'exclusive', ifAvailable: boolean }, callback: (lock: LockHandle | null) => Promise<void> | void): Promise<unknown> {
    if (this.held) {
      if (options.ifAvailable) {
        return Promise.resolve(callback(null))
      }
      // 排队等待（本实现不用于测试，直接断言不会走到）
      return new Promise(resolve => this.waiters.push(() => resolve(callback({ name, mode: options.mode }))))
    }
    this.held = true
    return new Promise((resolve) => {
      void callback({ name, mode: options.mode }).then(() => {
        this.held = false
        resolve(undefined)
        const next = this.waiters.shift()
        if (next) {
          next()
        }
      })
    })
  }
}

function withLockManager(manager: FakeLockManager | null) {
  const original = (navigator as unknown as { locks?: unknown }).locks
  if (manager === null) {
    delete (navigator as unknown as { locks?: unknown }).locks
  }
  else {
    Object.defineProperty(navigator, 'locks', { value: manager, configurable: true })
  }
  return () => {
    if (original === undefined) {
      delete (navigator as unknown as { locks?: unknown }).locks
    }
    else {
      Object.defineProperty(navigator, 'locks', { value: original, configurable: true })
    }
  }
}

/** 在组件内使用锁（onBeforeUnmount 需要 Vue 实例）。 */
function mountWithLock() {
  let exposed!: ReturnType<typeof useGameLock>
  const host = defineComponent({
    setup() {
      exposed = useGameLock()
      return () => h('div')
    },
  })
  const wrapper = mount(host)
  return { wrapper, lock: () => exposed }
}

/** 等待微任务队列排空（锁管理器内部以 then 链释放）。 */
async function flushMicrotasks() {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('多标签页控制（S4）', () => {
  it('web Locks 不可用时 supported=false 且无法取得锁', async () => {
    const restore = withLockManager(null)
    try {
      expect(webLocksSupported()).toBe(false)
      const { wrapper, lock } = mountWithLock()
      const granted = await lock().request()
      expect(granted).toBe(false)
      expect(lock().held.value).toBe(false)
      wrapper.unmount()
    }
    finally {
      restore()
    }
  })

  it('两页争用：先到者持有独占锁，后到者立即失败并保持只读', async () => {
    const manager = new FakeLockManager()
    const restore = withLockManager(manager)
    try {
      const pageA = mountWithLock()
      const pageB = mountWithLock()

      const grantedA = await pageA.lock().request()
      expect(grantedA).toBe(true)
      expect(pageA.lock().held.value).toBe(true)

      // 页 B ifAvailable 请求：立即失败
      const grantedB = await pageB.lock().request()
      expect(grantedB).toBe(false)
      expect(pageB.lock().held.value).toBe(false)
      expect(manager.isHeld()).toBe(true)

      // 页 A 释放后，页 B 可以接管（manager 内部的 then 回调需要 flush）
      pageA.lock().release()
      await flushMicrotasks()
      expect(pageA.lock().held.value).toBe(false)
      expect(manager.isHeld()).toBe(false)

      const grantedB2 = await pageB.lock().request()
      expect(grantedB2).toBe(true)
      expect(pageB.lock().held.value).toBe(true)
      pageB.wrapper.unmount()
    }
    finally {
      restore()
    }
  })

  it('重复请求幂等；释放后可再次获取', async () => {
    const manager = new FakeLockManager()
    const restore = withLockManager(manager)
    try {
      const page = mountWithLock()
      expect(await page.lock().request()).toBe(true)
      expect(await page.lock().request()).toBe(true) // 已持有，幂等
      page.lock().release()
      page.lock().release() // 幂等释放
      await flushMicrotasks()
      expect(await page.lock().request()).toBe(true)
      page.wrapper.unmount()
    }
    finally {
      restore()
    }
  })

  it('pagehide 事件释放锁；组件卸载释放锁', async () => {
    const manager = new FakeLockManager()
    const restore = withLockManager(manager)
    try {
      const page = mountWithLock()
      await page.lock().request()
      expect(manager.isHeld()).toBe(true)

      // pagehide（浏览器卸载 / bfcache 进入）
      window.dispatchEvent(new Event('pagehide'))
      await flushMicrotasks()
      expect(page.lock().held.value).toBe(false)
      expect(manager.isHeld()).toBe(false)

      // 重新获取后卸载组件也释放
      await page.lock().request()
      page.wrapper.unmount()
      await flushMicrotasks()
      expect(manager.isHeld()).toBe(false)
    }
    finally {
      restore()
    }
  })

  it('锁释放通知可被等待者观测（底层 promise 语义）', async () => {
    const manager = new FakeLockManager()
    const restore = withLockManager(manager)
    try {
      let released = false
      const lockPromise = manager.request('unojev:active-game', { mode: 'exclusive', ifAvailable: true }, async (lock) => {
        expect(lock).not.toBeNull()
        await new Promise<void>(resolve => setTimeout(resolve, 10))
        released = true
      })
      await lockPromise
      expect(released).toBe(true)
      expect(manager.isHeld()).toBe(false)
    }
    finally {
      restore()
    }
  })
})
void vi
