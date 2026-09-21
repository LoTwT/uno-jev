// @vitest-environment happy-dom
// 会话层共享测试辅助：假 Web Locks 管理器、可控存储、会话挂载。
// 供多标签页与 bfcache 场景使用（同一"浏览器"内多个会话实例共享它们）。
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { useUnoGame } from '~/composables/useUnoGame'

/** 简化版 Web Locks API mock：支持 exclusive + ifAvailable，跨"标签页"共享。 */
export class FakeLockManager {
  private held = false
  private waiters: Array<() => void> = []

  isHeld(): boolean {
    return this.held
  }

  request(
    name: string,
    options: { mode: 'exclusive', ifAvailable: boolean },
    callback: (lock: { name: string, mode: string } | null) => Promise<void> | void,
  ): Promise<unknown> {
    if (this.held) {
      if (options.ifAvailable) {
        return Promise.resolve(callback(null))
      }
      return new Promise(resolve => this.waiters.push(() => resolve(callback({ name, mode: options.mode }))))
    }
    this.held = true
    return new Promise((resolve) => {
      void Promise.resolve(callback({ name, mode: options.mode })).then(() => {
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

export function installLocks(manager: FakeLockManager | null) {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'locks')
    ?? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(navigator), 'locks')
  if (manager === null) {
    Object.defineProperty(navigator, 'locks', { value: null, configurable: true })
  }
  else {
    Object.defineProperty(navigator, 'locks', { value: manager, configurable: true })
  }
  return () => {
    if (descriptor) {
      Object.defineProperty(navigator, 'locks', descriptor)
    }
    else {
      delete (navigator as unknown as { locks?: unknown }).locks
    }
  }
}

/** 可注入故障的 Storage 替身（happy-dom 不允许在实例上替换方法）。 */
export class FakeStorage implements Storage {
  private map = new Map<string, string>()
  failSet = false
  failGet = false
  failRemove = false

  get length() {
    return this.map.size
  }

  clear() {
    this.map.clear()
  }

  getItem(key: string): string | null {
    if (this.failGet) {
      throw new DOMException('SecurityError', 'SecurityError')
    }
    return this.map.has(key) ? this.map.get(key)! : null
  }

  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null
  }

  removeItem(key: string): void {
    if (this.failRemove) {
      throw new DOMException('QuotaExceededError', 'QuotaExceededError')
    }
    this.map.delete(key)
  }

  setItem(key: string, value: string): void {
    if (this.failSet) {
      throw new DOMException('QuotaExceededError', 'QuotaExceededError')
    }
    this.map.set(key, value)
  }
}

export function installStorage(fake: Storage) {
  const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage')!
  Object.defineProperty(window, 'localStorage', { value: fake, configurable: true, writable: true })
  return () => {
    Object.defineProperty(window, 'localStorage', descriptor)
  }
}

/** 挂载一个使用 useUnoGame 的宿主组件，返回会话句柄。 */
export function mountSession() {
  let exposed!: ReturnType<typeof useUnoGame>
  const host = defineComponent({
    setup() {
      exposed = useUnoGame()
      return () => h('div')
    },
  })
  const wrapper = mount(host)
  return { wrapper, session: () => exposed }
}

/** 等待会话队列与挂载副作用完成。 */
export async function settle() {
  await flushPromises()
  await new Promise(resolve => setTimeout(resolve, 0))
  await flushPromises()
}
