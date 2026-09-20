import { mount } from '@vue/test-utils'
import { useLocalStorage } from '@vueuse/core'
// @vitest-environment happy-dom
// 问题 6 回归：浏览器存储被禁用（属性访问抛 SecurityError）时，
// 界面仍可渲染、偏好回退内存默认值，并明确提供不保存的临时对局；
// 临时模式不写共享存档，也不显示虚假的保存成功。
import { describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { usePreferences } from '~/composables/usePreferences'
import { FakeLockManager, installLocks, mountSession, settle } from './helpers'

/** 让 window.localStorage 的属性访问本身抛 SecurityError（模拟存储被禁用）。 */
function blockLocalStorage() {
  const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage')!
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    get() {
      throw new DOMException('Access is denied for this document.', 'SecurityError')
    },
  })
  return () => {
    Object.defineProperty(window, 'localStorage', descriptor)
  }
}

describe('存储被禁用（问题 6）', () => {
  it('会话初始化不抛异常：进入入口并标记存储不可用', async () => {
    const restoreLocks = installLocks(new FakeLockManager())
    const restoreStorage = blockLocalStorage()
    try {
      vi.stubGlobal('fetch', () => new Promise<Response>(() => {}))
      const { wrapper, session } = mountSession()
      await settle()
      expect(session().status.value).toBe('entry')
      expect(session().storageAvailable.value).toBe(false)
      expect(session().entrySave.value.status).toBe('absent')
      wrapper.unmount()
    }
    finally {
      restoreStorage()
      restoreLocks()
      vi.unstubAllGlobals()
    }
  })

  it('可进入不保存的临时对局：不写共享槽位、保存状态如实显示为内存模式', async () => {
    const restoreLocks = installLocks(new FakeLockManager())
    const restoreStorage = blockLocalStorage()
    try {
      vi.stubGlobal('fetch', () => new Promise<Response>(() => {}))
      const { wrapper, session } = mountSession()
      await settle()

      session().startTempGame()
      await settle()
      expect(session().status.value).toBe('playing')
      expect(session().state.value).not.toBeNull()
      expect(session().persistence.saveHealth.value, '临时模式不得显示已保存').toBe('memory-only')

      // 临时对局仍可推进（内存模式不因存储不可用而暂停）
      if (session().state.value!.currentPlayerId === 'p0' && session().state.value!.phase.kind === 'turn') {
        const revision = session().state.value!.revision
        session().drawOne()
        await settle()
        expect(session().state.value!.revision).toBe(revision + 1)
        expect(session().persistence.saveHealth.value).toBe('memory-only')
      }
      wrapper.unmount()
    }
    finally {
      restoreStorage()
      restoreLocks()
      vi.unstubAllGlobals()
    }
  })

  it('偏好回退内存默认值：主题 auto、减少动态 system，且不抛异常', async () => {
    const restoreStorage = blockLocalStorage()
    try {
      let prefs!: ReturnType<typeof usePreferences>
      const host = defineComponent({
        setup() {
          prefs = usePreferences()
          return () => h('div')
        },
      })
      const wrapper = mount(host)
      await settle()
      expect(prefs.themeIntent.value).toBe('auto')
      expect(prefs.settings.value).toEqual({ schemaVersion: 1, reducedMotion: 'system', revealHands: false })
      expect(prefs.reducedMotion.value).toBe(false)

      // 内存中修改仍可用（不写存储）
      prefs.setTheme('dark')
      await settle()
      expect(prefs.themeIntent.value).toBe('dark')
      wrapper.unmount()
    }
    finally {
      restoreStorage()
    }
  })

  it('对照：裸 useLocalStorage 在同一环境下会抛 SecurityError（说明必须传入安全 window 选项）', () => {
    const restoreStorage = blockLocalStorage()
    try {
      const host = defineComponent({
        setup() {
          useLocalStorage('probe:key', 'default')
          return () => h('div')
        },
      })
      expect(() => mount(host)).toThrow(/SecurityError|Access is denied/)
    }
    finally {
      restoreStorage()
    }
  })

  it('存储恢复后新会话可正常读写（对照，确认异常注入未污染环境）', async () => {
    const restoreLocks = installLocks(new FakeLockManager())
    try {
      vi.stubGlobal('fetch', () => new Promise<Response>(() => {}))
      const { wrapper, session } = mountSession()
      await settle()
      expect(session().storageAvailable.value).toBe(true)
      expect(await session().startNewGame()).toBe('started')
      expect(session().persistence.saveHealth.value).toBe('ok')
      expect(window.localStorage.getItem('unojev:save')).not.toBeNull()
      wrapper.unmount()
    }
    finally {
      restoreLocks()
      vi.unstubAllGlobals()
    }
  })
})
