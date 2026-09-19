import type { GameState } from '#shared/game'
// @vitest-environment happy-dom
// S3：保存时机（动作后立即保存）、写入失败处理（保留旧槽位 / 重试 / 临时模式）、
// 新局不清设置、坏存档加载保留原槽位
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { loadSaveEnvelope } from '#shared/game'
import { SAVE_KEY, useGamePersistence } from '~/composables/useGamePersistence'
import { useUnoGame } from '~/composables/useUnoGame'

/** 立即授予的 Web Locks mock（S4 的锁细节由 lock.test.ts 覆盖）。 */
function installGrantingLocks() {
  const manager = {
    request(_name: string, _options: unknown, callback: (lock: object | null) => Promise<void> | void) {
      return new Promise((resolve) => {
        void Promise.resolve(callback({ name: _name })).then(() => resolve(undefined))
      })
    },
  }
  Object.defineProperty(navigator, 'locks', { value: manager, configurable: true })
}

/** 可注入故障的 Storage 替身（happy-dom 不允许在实例上替换方法，需整体替换 window.localStorage）。 */
class FakeStorage implements Storage {
  private map = new Map<string, string>()
  failSet = false
  get length() { return this.map.size }
  clear() { this.map.clear() }
  getItem(key: string): string | null { return this.map.has(key) ? this.map.get(key)! : null }
  key(index: number): string | null { return [...this.map.keys()][index] ?? null }
  removeItem(key: string): void { this.map.delete(key) }
  setItem(key: string, value: string): void {
    if (this.failSet) {
      throw new DOMException('QuotaExceededError', 'QuotaExceededError')
    }
    this.map.set(key, value)
  }
}

function installStorage(fake: Storage) {
  // happy-dom 的 localStorage 是 window 的自有属性；替换后必须按原描述符恢复
  const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage')!
  Object.defineProperty(window, 'localStorage', { value: fake, configurable: true, writable: true })
  return () => {
    Object.defineProperty(window, 'localStorage', descriptor)
  }
}

function mountSession() {
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

async function settle() {
  await flushPromises()
  await new Promise(resolve => setTimeout(resolve, 0))
  await flushPromises()
}

function readSlot(): string | null {
  return window.localStorage.getItem(SAVE_KEY)
}

beforeEach(() => {
  window.localStorage.clear()
  installGrantingLocks()
  // 持久化测试不关心 AI 决策：fetch 悬挂，AI 回合不推进
  vi.stubGlobal('fetch', () => new Promise<Response>(() => {}))
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete (navigator as unknown as { locks?: unknown }).locks
})

describe('保存时机与存档内容（S3）', () => {
  it('创建新局后立即保存首个快照；动作后立即保存新快照', async () => {
    const { wrapper, session } = mountSession()
    await settle()

    expect(session().status.value).toBe('entry')
    session().startNewGame()
    await settle()

    expect(session().status.value).toBe('playing')
    const state = session().state.value!
    const raw = readSlot()
    expect(raw).not.toBeNull()
    const envelope = loadSaveEnvelope(raw!)
    expect(envelope.ok).toBe(true)
    if (envelope.ok) {
      expect(envelope.envelope.state.gameId).toBe(state.gameId)
      expect(envelope.envelope.state.revision).toBe(0)
      expect(envelope.envelope.writerId).toBe(session().writerId)
    }

    // 真人动作后立即保存（revision +1 的快照）
    const before = structuredClone(state)
    const isHumanFirst = state.currentPlayerId === 'p0' && state.phase.kind === 'turn'
    if (isHumanFirst) {
      session().drawOne()
      await settle()
      const updated = loadSaveEnvelope(readSlot()!)
      expect(updated.ok).toBe(true)
      if (updated.ok) {
        expect(updated.envelope.state.revision).toBe(before.revision + 1)
      }
      // 刷新不重复抽牌：存档阶段与内存状态一致
      expect(session().state.value!.revision).toBe(before.revision + 1)
    }
    else {
      // 庄家随机，AI 先手的情形下快照仍应等于内存状态
      expect(loadSaveEnvelope(readSlot()!)?.envelope?.state.revision ?? -1).toBe(0)
    }
    wrapper.unmount()
  })

  it('存档 envelope 结构：schemaVersion 1 + savedAt + writerId + 完整状态', async () => {
    const { wrapper, session } = mountSession()
    await settle()
    session().startNewGame()
    await settle()
    const parsed = JSON.parse(readSlot()!) as Record<string, unknown>
    expect(parsed.schemaVersion).toBe(1)
    expect(typeof parsed.savedAt).toBe('string')
    expect(typeof parsed.writerId).toBe('string')
    expect(typeof (parsed.state as GameState).drawPile?.length).toBe('number')
    wrapper.unmount()
  })
})

describe('写入失败处理（S3）', () => {
  it('写入失败：保留旧槽位、内存状态保留、暂停自动推进、可重试', async () => {
    const fake = new FakeStorage()
    const restoreStorage = installStorage(fake)
    try {
      const { wrapper, session } = mountSession()
      await settle()
      session().startNewGame()
      await settle()
      expect(session().persistence.saveHealth.value).toBe('ok')
      const firstRaw = readSlot()!

      // 模拟 quota 错误
      fake.failSet = true
      const humanTurn = session().state.value!.currentPlayerId === 'p0' && session().state.value!.phase.kind === 'turn'
      if (humanTurn) {
        session().drawOne()
        await settle()
        expect(session().persistence.saveHealth.value).toBe('failed')
        expect(readSlot()).toBe(firstRaw)
        expect(session().state.value!.revision).toBe(1)
      }
      else {
        // AI 先手：直接持久化一个修改过的快照（revision 推进）触发写入失败
        const bumped = { ...structuredClone(session().state.value!), revision: session().state.value!.revision + 1 }
        const failed = session().persistence.persist(bumped, 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff')
        expect(failed).toBe(false)
        expect(session().persistence.saveHealth.value).toBe('failed')
        expect(readSlot()).toBe(firstRaw)
      }

      // 重试保存成功（故障恢复）
      fake.failSet = false
      session().retrySave()
      await settle()
      expect(session().persistence.saveHealth.value).toBe('ok')
      const retried = loadSaveEnvelope(readSlot()!)
      expect(retried.ok).toBe(true)
      // 重试成功后槽位恢复为可读，且与当前内存状态一致
      expect(retried.ok && retried.envelope.state.revision).toBe(session().state.value!.revision)
      wrapper.unmount()
    }
    finally {
      restoreStorage()
    }
  })

  it('仅在此页继续：进入内存模式后不再写共享槽位', async () => {
    const { wrapper, session } = mountSession()
    await settle()
    session().startNewGame()
    await settle()
    const rawBefore = readSlot()

    session().continueInMemoryOnly()
    await settle()
    expect(session().persistence.saveHealth.value).toBe('memory-only')

    if (session().state.value!.currentPlayerId === 'p0' && session().state.value!.phase.kind === 'turn') {
      session().drawOne()
      await settle()
      // 内存模式下槽位不再更新
      expect(readSlot()).toBe(rawBefore)
      // 但本页状态继续推进
      expect(session().state.value!.revision).toBe(1)
    }
    wrapper.unmount()
  })

  it('storage 一开始就不可用：同样进入受控失败状态而非崩溃', async () => {
    const fake = new FakeStorage()
    fake.failSet = true
    const restoreStorage = installStorage(fake)
    try {
      const { wrapper, session } = mountSession()
      await settle()
      session().startNewGame()
      await settle()
      // 游戏进入可玩状态，但保存状态明确为失败（不显示虚假的已保存）
      expect(session().status.value).toBe('playing')
      expect(session().persistence.saveHealth.value).toBe('failed')
      wrapper.unmount()
    }
    finally {
      restoreStorage()
    }
  })
})

describe('设置独立于对局存档（S3）', () => {
  it('开始新局不清除主题与偏好设置', async () => {
    window.localStorage.setItem('unojev:theme', '"dark"')
    window.localStorage.setItem('unojev:settings', '{"schemaVersion":1,"reducedMotion":"reduce"}')

    const { wrapper, session } = mountSession()
    await settle()
    session().startNewGame()
    await settle()

    expect(window.localStorage.getItem('unojev:theme')).toBe('"dark"')
    expect(window.localStorage.getItem('unojev:settings')).toBe('{"schemaVersion":1,"reducedMotion":"reduce"}')
    wrapper.unmount()
  })
})

describe('坏存档加载（S2 会话侧）', () => {
  it('坏 JSON 保留原槽位并提示，不自动重置', async () => {
    window.localStorage.setItem(SAVE_KEY, '{corrupted')
    const { wrapper, session } = mountSession()
    await settle()
    // 锁已获得但存档无法读取
    expect(session().status.value).toBe('invalid-save')
    expect(session().entrySave.value.status).toBe('invalid')
    // 原槽位仍在
    expect(readSlot()).toBe('{corrupted')

    // 用户确认后清除并新开一局
    session().clearInvalidSaveAndStart()
    await settle()
    expect(session().status.value).toBe('playing')
    const after = loadSaveEnvelope(readSlot()!)
    expect(after.ok).toBe(true)
    wrapper.unmount()
  })

  it('useGamePersistence：校验失败的原始内容保留，loadInitial 不覆盖', () => {
    const bad = JSON.stringify({ schemaVersion: 2, savedAt: 'x', writerId: 'y', state: {} })
    window.localStorage.setItem(SAVE_KEY, bad)
    let persistence!: ReturnType<typeof useGamePersistence>
    const host = defineComponent({
      setup() {
        persistence = useGamePersistence()
        return () => h('div')
      },
    })
    const wrapper = mount(host)
    const result = persistence.loadInitial()
    expect(result.status).toBe('invalid')
    expect(window.localStorage.getItem(SAVE_KEY)).toBe(bad)
    wrapper.unmount()
  })
})
