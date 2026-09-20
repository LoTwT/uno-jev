import type { Ref } from 'vue'
/**
 * 多标签页控制权：同源 Web Locks API 独占锁 unojev:active-game。
 *
 * 控制页在对局会话期间持有锁；其他页显示只读快照。
 * 释放控制权前由调用方先停调度、取消请求并作废请求代次；
 * pagehide 与组件销毁时自动释放，页面从历史缓存（bfcache）返回需重新争取。
 * 缺少 Web Locks 的浏览器不读写共享对局槽位来继续游戏（规格：多标签页与冲突）。
 */
import { onBeforeUnmount, readonly, ref } from 'vue'

export const GAME_LOCK_NAME = 'unojev:active-game'

export interface GameLock {
  /** Web Locks API 是否可用。 */
  supported: Readonly<Ref<boolean>>
  /** 本页当前是否持有控制权。 */
  held: Readonly<Ref<boolean>>
  /** 尝试争取锁；立即返回是否获得（不等待其他页面释放）。 */
  request: () => Promise<boolean>
  /** 释放锁；幂等。 */
  release: () => void
  /** 注册历史缓存（bfcache）恢复回调（pageshow persisted）；返回取消注册函数。 */
  onRestored: (callback: () => void) => () => void
}

export function webLocksSupported(): boolean {
  // happy-dom 等环境下 navigator.locks 可能为 null，需要同时排除 null 与 undefined
  return typeof navigator !== 'undefined' && navigator.locks != null && typeof navigator.locks.request === 'function'
}

export function useGameLock(): GameLock {
  const supported = ref(false)
  const held = ref(false)
  let releaseResolvers: Array<() => void> = []

  function release() {
    if (!held.value && releaseResolvers.length === 0) {
      return
    }
    held.value = false
    const resolvers = releaseResolvers
    releaseResolvers = []
    for (const resolve of resolvers) {
      resolve()
    }
  }

  function request(): Promise<boolean> {
    if (!webLocksSupported()) {
      supported.value = false
      return Promise.resolve(false)
    }
    supported.value = true
    if (held.value) {
      return Promise.resolve(true)
    }
    return new Promise<boolean>((resolve) => {
      let settled = false
      const settle = (value: boolean) => {
        if (!settled) {
          settled = true
          resolve(value)
        }
      }
      navigator.locks.request(
        GAME_LOCK_NAME,
        { mode: 'exclusive', ifAvailable: true },
        (lock) => {
          if (!lock) {
            settle(false)
            return
          }
          held.value = true
          settle(true)
          // 保持锁直到 release() 被调用
          return new Promise<void>((resolveLock) => {
            releaseResolvers.push(resolveLock)
          })
        },
      ).catch(() => settle(false))
    })
  }

  const restoreCallbacks = new Set<() => void>()

  /** 注册 bfcache 恢复回调；返回取消注册函数。 */
  function onRestored(callback: () => void): () => void {
    restoreCallbacks.add(callback)
    return () => restoreCallbacks.delete(callback)
  }

  if (typeof window !== 'undefined') {
    // 释放控制权：pagehide / 组件销毁时释放；历史缓存返回（pageshow persisted）时通知会话层重新争取
    const onPageHide = () => release()
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) {
        return
      }
      for (const callback of [...restoreCallbacks]) {
        callback()
      }
    }
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('pageshow', onPageShow as EventListener)
    onBeforeUnmount(() => {
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('pageshow', onPageShow as EventListener)
      restoreCallbacks.clear()
      release()
    })
  }

  return {
    supported: readonly(supported),
    held: readonly(held),
    request,
    release,
    onRestored,
  }
}
