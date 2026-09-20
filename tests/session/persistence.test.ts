import type { GameState } from '#shared/game'
// @vitest-environment happy-dom
// S3：保存时机（动作后立即保存）、写入失败处理（保留旧槽位 / 重试 / 临时模式）、
// 新局不清设置、坏存档加载保留原槽位
// 第二轮审查问题 2 回归：坏档未经确认不得被新局覆盖；清除前重新取锁并重读槽位，
// 内容变化时更新界面并要求重新确认（"未确认"与"没有有效签名"必须区分）。
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { loadSaveEnvelope, serializeSaveEnvelope } from '#shared/game'
import { SAVE_KEY, useGamePersistence } from '~/composables/useGamePersistence'
import { useUnoGame } from '~/composables/useUnoGame'
import { cardOf, makeGame } from '../rules/helpers'

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

const WRITER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const OTHER_WRITER = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'

/** 进行中的有效对局（p0 行动）。 */
function validInProgressState(): GameState {
  return makeGame({
    dealerId: 'p3',
    openingId: cardOf({ kind: 'number', color: 'red', value: 5 }),
    hands: {
      p0: ['red-1-2', 'blue-9-1', 'green-9-1', 'yellow-9-1', 'blue-8-1', 'green-8-1', 'wild-4'],
      p1: ['blue-5-2', 'red-3-2', 'green-skip-2', 'yellow-reverse-1', 'wild-1', 'wild-draw-four-1', 'blue-9-2'],
      p2: ['green-1-2', 'green-2-2', 'green-3-2', 'green-4-2', 'green-5-2', 'green-6-2', 'green-7-2'],
      p3: ['yellow-1-2', 'yellow-2-2', 'yellow-3-2', 'yellow-4-2', 'yellow-5-2', 'yellow-6-2', 'yellow-7-2'],
    },
  })
}

function writeEnvelope(state: GameState, writerId = WRITER): string {
  const raw = serializeSaveEnvelope({
    schemaVersion: 1,
    savedAt: '2026-09-20T00:00:00.000Z',
    writerId,
    state,
  })
  window.localStorage.setItem(SAVE_KEY, raw)
  return raw
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

  it('持续配额不足：重试保存失败保持当前对局与失败入口，不进入槽位冲突（问题 3 回归）', async () => {
    const fake = new FakeStorage()
    const restoreStorage = installStorage(fake)
    try {
      const { wrapper, session } = mountSession()
      await settle()
      session().startNewGame()
      await settle()
      expect(session().persistence.saveHealth.value).toBe('ok')
      const firstRaw = readSlot()!

      // 写入开始持续失败
      fake.failSet = true
      const humanTurn = session().state.value!.currentPlayerId === 'p0' && session().state.value!.phase.kind === 'turn'
      if (humanTurn) {
        session().drawOne()
      }
      else {
        // AI 先手：直接持久化一个推进过的快照触发失败
        const bumped = { ...structuredClone(session().state.value!), revision: session().state.value!.revision + 1 }
        session().persistence.persist(bumped, session().writerId)
      }
      await settle()
      expect(session().persistence.saveHealth.value).toBe('failed')
      const memoryRevision = session().state.value!.revision

      // 重试仍失败：必须保持 playing + failed，而不是 slot-conflict
      session().retrySave()
      await settle()
      expect(session().status.value, '持续写入失败不应进入槽位冲突').toBe('playing')
      expect(session().persistence.saveHealth.value).toBe('failed')
      // 内存进度保留，旧槽位未被破坏
      expect(session().state.value!.revision).toBe(memoryRevision)
      expect(readSlot()).toBe(firstRaw)

      // 失败提示条的两个入口仍可用：仅此页继续
      session().continueInMemoryOnly()
      await settle()
      expect(session().persistence.saveHealth.value).toBe('memory-only')
      expect(session().status.value).toBe('playing')

      // 存储恢复后（新局路径）保存重新可用：重试保存入口在 failed 状态下依然工作
      const { wrapper: wrapper2, session: session2 } = mountSession()
      await settle()
      // 槽位里还有上一个会话的进行中对局：按新局保护先确认覆盖
      expect(await session2().startNewGame()).toBe('needs-confirmation')
      expect(await session2().startNewGame(session2().currentSlotSignature())).toBe('started')
      await settle()
      fake.failSet = true
      const humanTurn2 = session2().state.value!.currentPlayerId === 'p0' && session2().state.value!.phase.kind === 'turn'
      if (humanTurn2) {
        session2().drawOne()
      }
      else {
        const bumped2 = { ...structuredClone(session2().state.value!), revision: session2().state.value!.revision + 1 }
        session2().persistence.persist(bumped2, session2().writerId)
      }
      await settle()
      expect(session2().persistence.saveHealth.value).toBe('failed')
      fake.failSet = false
      session2().retrySave()
      await settle()
      expect(session2().persistence.saveHealth.value).toBe('ok')
      expect(session2().status.value).toBe('playing')
      wrapper2.unmount()
      wrapper.unmount()
    }
    finally {
      restoreStorage()
    }
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

describe('坏档确认保护（第二轮审查问题 2）', () => {
  it('入口无存档、点击新局前槽位变成坏档：进入"存档无法读取"，不覆盖原始内容', async () => {
    const { wrapper, session } = mountSession()
    await settle()
    expect(session().status.value).toBe('entry')
    expect(session().entrySave.value.status).toBe('absent')

    // 点击新局前槽位被写成坏 JSON（其他页面 / 扩展写入）
    window.localStorage.setItem(SAVE_KEY, '{corrupted')

    const result = await session().startNewGame()
    expect(result, '不得开始新局').toBe('blocked')
    expect(session().status.value, '新发现的坏档进入"存档无法读取"').toBe('invalid-save')
    expect(session().state.value).toBeNull()
    expect(readSlot(), '坏档不得被新局覆盖').toBe('{corrupted')

    // 用户明确选择清除并新开后才可以替换
    session().clearInvalidSaveAndStart()
    await settle()
    expect(session().status.value).toBe('playing')
    expect(loadSaveEnvelope(readSlot()!).ok).toBe(true)
    wrapper.unmount()
  })

  it('清除坏档前内容被换成另一份坏档：更新界面并要求重新确认，不清除', async () => {
    window.localStorage.setItem(SAVE_KEY, '{corrupted')
    const { wrapper, session } = mountSession()
    await settle()
    expect(session().status.value).toBe('invalid-save')

    // 另一页面把坏档换成另一份坏档
    const replaced = JSON.stringify({ schemaVersion: 2, savedAt: 'x', writerId: OTHER_WRITER, state: {} })
    window.localStorage.setItem(SAVE_KEY, replaced)

    session().clearInvalidSaveAndStart()
    await settle()
    expect(session().status.value, '内容变化后要求重新确认').toBe('invalid-save')
    expect(readSlot(), '不得清除其他页面写入的内容').toBe(replaced)
    expect(session().entrySave.value.status).toBe('invalid')
    expect(session().entrySave.value.message).toContain('2')

    // 用户按最新内容再次确认后才清除并新开
    session().clearInvalidSaveAndStart()
    await settle()
    expect(session().status.value).toBe('playing')
    expect(loadSaveEnvelope(readSlot()!).ok).toBe(true)
    wrapper.unmount()
  })

  it('清除坏档前槽位变成有效存档：保留新存档并回到入口，仍需确认覆盖', async () => {
    window.localStorage.setItem(SAVE_KEY, '{corrupted')
    const { wrapper, session } = mountSession()
    await settle()
    expect(session().status.value).toBe('invalid-save')

    // 另一页面写入进行中的有效对局
    const replaced = writeEnvelope(validInProgressState(), OTHER_WRITER)
    expect(loadSaveEnvelope(replaced).ok, '构造的对局存档应有效').toBe(true)

    session().clearInvalidSaveAndStart()
    await settle()
    expect(session().status.value, '保留新存档并回到入口').toBe('entry')
    expect(readSlot()).toBe(replaced)
    expect(session().entrySave.value.status).toBe('valid')
    expect(session().slotNeedsConfirmation(), '进行中的新存档仍需确认').toBe(true)
    wrapper.unmount()
  })

  it('有效进行中存档的版本确认保护仍然生效（回归保护）', async () => {
    writeEnvelope(validInProgressState(), OTHER_WRITER)
    const { wrapper, session } = mountSession()
    await settle()
    expect(session().status.value).toBe('entry')

    // 未携带确认：不覆盖
    const slotBefore = readSlot()
    expect(await session().startNewGame()).toBe('needs-confirmation')
    expect(readSlot()).toBe(slotBefore)

    // 按当前签名确认后才可覆盖
    expect(await session().startNewGame(session().currentSlotSignature())).toBe('started')
    expect(readSlot()).not.toBe(slotBefore)
    wrapper.unmount()
  })

  it('已结束的对局无需确认即可新开（回归保护）', async () => {
    const finished = validInProgressState()
    finished.phase = { kind: 'finished', result: { reason: 'blocked', winnerId: null } }
    const raw = writeEnvelope(finished, OTHER_WRITER)
    expect(loadSaveEnvelope(raw).ok, '构造的已结束存档应有效').toBe(true)

    const { wrapper, session } = mountSession()
    await settle()
    expect(session().slotNeedsConfirmation()).toBe(false)
    expect(await session().startNewGame()).toBe('started')
    expect(session().status.value).toBe('playing')
    wrapper.unmount()
  })
})
