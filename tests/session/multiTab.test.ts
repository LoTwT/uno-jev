// @vitest-environment happy-dom
// 问题 2 回归：新局不得覆盖另一标签页写入的进行中对局。
// 用同一"浏览器"内的两个会话实例（共享假锁管理器与共享存储）复现审查路径：
// 本页从已结束/陈旧入口状态出发，另一页写入进行中的新对局，本页再新开局。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadSaveEnvelope } from '#shared/game'
import { SAVE_KEY } from '~/composables/useGamePersistence'
import { FakeLockManager, installLocks, mountSession, settle } from './helpers'

let lockManager: FakeLockManager
let restoreLocks: () => void

function slotGameId(): string | null {
  const raw = window.localStorage.getItem(SAVE_KEY)
  if (!raw) {
    return null
  }
  const parsed = loadSaveEnvelope(raw)
  return parsed.ok ? parsed.envelope.state.gameId : null
}

function slotSignature(): { gameId: string, revision: number, writerId: string } | null {
  const raw = window.localStorage.getItem(SAVE_KEY)
  if (!raw) {
    return null
  }
  const parsed = loadSaveEnvelope(raw)
  return parsed.ok
    ? { gameId: parsed.envelope.state.gameId, revision: parsed.envelope.state.revision, writerId: parsed.envelope.writerId }
    : null
}

beforeEach(() => {
  window.localStorage.clear()
  lockManager = new FakeLockManager()
  restoreLocks = installLocks(lockManager)
  // 不关心 AI 决策：fetch 悬挂
  vi.stubGlobal('fetch', () => new Promise<Response>(() => {}))
})

afterEach(() => {
  vi.unstubAllGlobals()
  restoreLocks()
})

describe('新局覆盖保护（问题 2）', () => {
  it('本页陈旧入口状态再新开局：发现另一标签页的进行中对局时要求重新确认，不静默覆盖', async () => {
    // 页 A：开始并返回入口（释放锁），入口快照停留在自己的对局
    const a = mountSession()
    await settle()
    expect(await a.session().startNewGame()).toBe('started')
    const gameA = slotGameId()
    expect(gameA).not.toBeNull()
    a.session().exitToEntry()
    await settle()
    expect(a.session().status.value).toBe('entry')

    // 页 B：接管控制权，确认覆盖后写入进行中的新对局，然后返回入口释放锁
    const b = mountSession()
    await settle()
    expect(b.session().status.value).toBe('entry')
    expect(await b.session().startNewGame(), '页 B 也需要先确认覆盖').toBe('needs-confirmation')
    expect(await b.session().startNewGame(b.session().currentSlotSignature())).toBe('started')
    const gameB = slotGameId()
    expect(gameB).not.toBeNull()
    expect(gameB).not.toBe(gameA)
    b.session().exitToEntry()
    await settle()

    // 页 A 不知道 B 的写入（其入口快照仍是旧对局），直接新开局：
    // 取锁后重新读取最新存档，返回 needs-confirmation，槽位保持不变
    const slotBefore = window.localStorage.getItem(SAVE_KEY)
    const result = await a.session().startNewGame()
    // 首先断言真正的缺陷：槽位不得被静默覆盖（旧版会在此失败）
    expect(window.localStorage.getItem(SAVE_KEY), '槽位不得被静默覆盖').toBe(slotBefore)
    expect(slotGameId()).toBe(gameB)
    expect(result, '应要求重新确认').toBe('needs-confirmation')
    // 界面已更新为最新存档（可展示给用户重新确认）
    expect(a.session().entrySave.value.status).toBe('valid')
    if (a.session().entrySave.value.status === 'valid') {
      expect(a.session().entrySave.value.envelope?.state.gameId).toBe(gameB)
    }
    expect(a.session().slotNeedsConfirmation()).toBe(true)

    // 用户按最新进度确认后，才允许覆盖
    const confirmed = await a.session().startNewGame(a.session().currentSlotSignature())
    expect(confirmed).toBe('started')
    expect(slotGameId()).not.toBe(gameB)
    expect(slotSignature()!.writerId).toBe(a.session().writerId)

    a.wrapper.unmount()
    b.wrapper.unmount()
  })

  it('确认后槽位再次变化：再次要求确认（确认的版本必须与写入时的槽位一致）', async () => {
    const a = mountSession()
    await settle()
    expect(await a.session().startNewGame()).toBe('started')
    a.session().exitToEntry()
    await settle()

    // 用户看到并确认的是当前版本
    const confirmedSignature = a.session().currentSlotSignature()
    expect(confirmedSignature).not.toBeNull()

    // 确认之后、写入之前，另一标签页又写入了新对局（页 B 确认覆盖后写入）
    const b = mountSession()
    await settle()
    expect(await b.session().startNewGame()).toBe('needs-confirmation')
    expect(await b.session().startNewGame(b.session().currentSlotSignature())).toBe('started')
    b.session().exitToEntry()
    await settle()

    const slotBefore = window.localStorage.getItem(SAVE_KEY)
    const result = await a.session().startNewGame(confirmedSignature)
    expect(result).toBe('needs-confirmation')
    expect(window.localStorage.getItem(SAVE_KEY)).toBe(slotBefore)

    // 按最新签名重新确认后成功
    expect(await a.session().startNewGame(a.session().currentSlotSignature())).toBe('started')

    a.wrapper.unmount()
    b.wrapper.unmount()
  })

  it('继续对局使用取锁后的最新状态，而不是本页陈旧入口快照', async () => {
    const a = mountSession()
    await settle()
    expect(await a.session().startNewGame()).toBe('started')
    const gameA = slotGameId()
    a.session().exitToEntry()
    await settle()

    // 另一标签页确认覆盖并写入新对局后离开
    const b = mountSession()
    await settle()
    expect(await b.session().startNewGame()).toBe('needs-confirmation')
    expect(await b.session().startNewGame(b.session().currentSlotSignature())).toBe('started')
    const gameB = slotGameId()
    expect(gameB).not.toBe(gameA)
    b.session().exitToEntry()
    await settle()

    // 页 A 继续：应加载 B 的最新对局
    a.session().continueGame()
    await settle()
    expect(a.session().status.value).toBe('playing')
    expect(a.session().state.value?.gameId).toBe(gameB)

    a.wrapper.unmount()
    b.wrapper.unmount()
  })

  it('槽位为空或只有已结束对局时，新开局无需确认', async () => {
    const a = mountSession()
    await settle()
    // 槽位为空：直接开始
    expect(await a.session().startNewGame()).toBe('started')
    expect(a.session().slotNeedsConfirmation()).toBe(false)
    a.wrapper.unmount()
  })
})
