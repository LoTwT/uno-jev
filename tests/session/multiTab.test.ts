// @vitest-environment happy-dom
// 问题 2 回归：新局不得覆盖另一标签页写入的进行中对局。
// 用同一"浏览器"内的两个会话实例（共享假锁管理器与共享存储）复现审查路径：
// 本页从已结束/陈旧入口状态出发，另一页写入进行中的新对局，本页再新开局。
// 第三轮审查问题 1 回归：内存对局（临时对局 / 仅此页继续）的再次开局与清除入口
// 不得依赖或修改共享槽位——"允许操作内存对局"不等于"拥有共享槽位写权限"。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadSaveEnvelope } from '#shared/game'
import { SAVE_KEY } from '~/composables/useGamePersistence'
import { cardOf, makeGame, mulberry32 } from '../rules/helpers'
import { FakeLockManager, FakeStorage, installLocks, installStorage, mountSession, settle } from './helpers'

let lockManager: FakeLockManager
let restoreLocks: () => void

const WRITER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

/** 进行中的有效对局（p0 行动）。 */
function validInProgressState() {
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

function writeSave(state: ReturnType<typeof validInProgressState>): string {
  const raw = JSON.stringify({ schemaVersion: 1, savedAt: '2026-09-20T00:00:00.000Z', writerId: WRITER, state })
  window.localStorage.setItem(SAVE_KEY, raw)
  return raw
}

/**
 * 确定性 AI 决策替身：总是抽牌 / 保留，不发起真实网络请求。
 * 用于把对局推进到结束（双方只抽牌时以"无进展和局"收尾）。
 */
function deterministicAiFetch(_url: unknown, init?: RequestInit): Promise<Response> {
  const request = JSON.parse(String(init?.body)) as {
    gameId: string
    revision: number
    decisionId: string
    actorId: string
    candidates: Array<{ id: string, action: { type: string } }>
  }
  const chosen = request.candidates.find(c => c.action.type === 'draw-one')
    ?? request.candidates.find(c => c.action.type === 'keep-drawn')
    ?? request.candidates[0]!
  return Promise.resolve(new Response(JSON.stringify({
    protocolVersion: 1,
    gameId: request.gameId,
    revision: request.revision,
    decisionId: request.decisionId,
    actorId: request.actorId,
    actionId: chosen.id,
    source: 'jev',
    model: 'jev-1.13.0',
  }), { status: 200, headers: { 'content-type': 'application/json' } }))
}

function dispatchPageShowPersisted() {
  const event = new Event('pageshow')
  Object.defineProperty(event, 'persisted', { value: true })
  window.dispatchEvent(event)
}

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
  // 恢复 Math.random 等替身：随机输入不泄漏到其他用例
  vi.restoreAllMocks()
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

describe('内存对局与共享槽位隔离（第三轮审查问题 1）', () => {
  // 断言失败时也要卸载：未卸载的会话仍监听 pageshow，会持有锁并干扰后续用例
  const mounted: Array<ReturnType<typeof mountSession>> = []
  function mountTracked() {
    const host = mountSession()
    mounted.push(host)
    return host
  }
  afterEach(() => {
    for (const host of mounted.splice(0)) {
      host.wrapper.unmount()
    }
  })

  it('无 Web Locks + 共享坏档：完成临时对局后重开成功，原始槽位字节不变', async () => {
    const restoreNoLocks = installLocks(null)
    try {
      const badRaw = '{corrupted-shared-slot'
      window.localStorage.setItem(SAVE_KEY, badRaw)
      // 确定性的开局与 AI 决策：对局可重复地推进到结束
      vi.spyOn(Math, 'random').mockImplementation(mulberry32(1))
      vi.stubGlobal('fetch', deterministicAiFetch)

      const { session } = mountTracked()
      await settle()
      expect(session().status.value).toBe('no-lock-browser')
      session().startTempGame()
      await settle()
      expect(session().persistence.saveHealth.value).toBe('memory-only')

      // 用正常动作完成一局（双方只抽牌 / 保留，以无进展和局收尾）
      for (let turn = 0; turn < 200 && session().state.value!.phase.kind !== 'finished'; turn++) {
        const state = session().state.value!
        expect(state.currentPlayerId, '临时对局由真人推进').toBe('p0')
        if (state.phase.kind === 'opening-color') {
          session().chooseOpeningColor('red')
        }
        else if (state.phase.kind === 'after-draw') {
          session().keepDrawn()
        }
        else {
          session().drawOne()
        }
        await settle()
      }
      expect(session().state.value!.phase.kind, '临时对局已结束').toBe('finished')
      expect(window.localStorage.getItem(SAVE_KEY), '临时对局不写共享槽位').toBe(badRaw)
      const finishedGameId = session().state.value!.gameId

      // 再来一局：只重建内存状态，不进入存档异常 / 清除流程
      const result = await session().startNewGame()
      await settle()
      expect(result, '内存对局重开不因共享坏档被阻塞').toBe('started')
      expect(session().status.value, '不进入 invalid-save').toBe('playing')
      expect(session().state.value!.gameId, '新局使用新 gameId').not.toBe(finishedGameId)
      expect(session().persistence.saveHealth.value, '继续明确显示不保存').toBe('memory-only')
      expect(session().lock.held.value, '不依赖 Web Locks').toBe(false)
      expect(window.localStorage.getItem(SAVE_KEY), '原始槽位字节不变').toBe(badRaw)
    }
    finally {
      restoreNoLocks()
    }
  })

  it('仅此页继续 + 另一页持锁：重开仍能进行，共享存档不变', async () => {
    const fake = new FakeStorage()
    const restoreStorage = installStorage(fake)
    try {
      const rawBefore = writeSave(validInProgressState())
      const a = mountTracked()
      await settle()
      a.session().continueGame()
      await settle()
      expect(a.session().status.value).toBe('playing')

      // 写入失败后用户选择"仅在此页继续"
      fake.failSet = true
      expect(a.session().state.value!.currentPlayerId).toBe('p0')
      a.session().drawOne()
      await settle()
      expect(a.session().persistence.saveHealth.value).toBe('failed')
      a.session().continueInMemoryOnly()
      await settle()
      expect(a.session().persistence.saveHealth.value).toBe('memory-only')

      // 页 A 进入历史缓存释放锁；页 B 接管控制权并保持持锁
      window.dispatchEvent(new Event('pagehide'))
      await settle()
      const b = mountTracked()
      await settle()
      expect(b.session().lock.held.value).toBe(true)
      dispatchPageShowPersisted()
      await settle()
      expect(a.session().status.value).toBe('playing')
      expect(a.session().lock.held.value).toBe(false)

      // 重开：不取锁、不读共享槽位
      const previousGameId = a.session().state.value!.gameId
      const result = await a.session().startNewGame()
      await settle()
      expect(result).toBe('started')
      expect(a.session().status.value).toBe('playing')
      expect(a.session().state.value!.gameId).not.toBe(previousGameId)
      expect(a.session().persistence.saveHealth.value).toBe('memory-only')
      expect(a.session().lock.held.value, '内存对局重开不取锁').toBe(false)
      expect(b.session().lock.held.value, '另一页保持控制权').toBe(true)
      expect(window.localStorage.getItem(SAVE_KEY), '共享存档不变').toBe(rawBefore)
    }
    finally {
      restoreStorage()
    }
  })

  it('内存模式不能通过清除入口修改共享槽位', async () => {
    const restoreNoLocks = installLocks(null)
    try {
      const badRaw = '{corrupted-shared-slot'
      window.localStorage.setItem(SAVE_KEY, badRaw)
      const { session } = mountTracked()
      await settle()
      expect(session().status.value).toBe('no-lock-browser')

      session().startTempGame()
      await settle()
      const previousGameId = session().state.value!.gameId
      expect(session().persistence.saveHealth.value).toBe('memory-only')

      // 复现路径：先按"再来一局"，再走页面提供的"清除并新开一局"入口。
      // 旧实现在这两步之间进入 invalid-save，并由清除入口在未持锁时删除共享槽位；
      // 这里先断言共享槽位不被修改，再看内存对局是否照常重开
      const restartResult = await session().startNewGame()
      await settle()
      session().clearInvalidSaveAndStart()
      await settle()
      expect(window.localStorage.getItem(SAVE_KEY), '不得删除共享槽位').toBe(badRaw)
      expect(restartResult, '重开只重建内存状态').toBe('started')
      expect(session().status.value, '不进入 invalid-save').toBe('playing')
      expect(session().state.value!.gameId).not.toBe(previousGameId)
      expect(session().persistence.saveHealth.value).toBe('memory-only')
    }
    finally {
      restoreNoLocks()
    }
  })

  it('对照：正常持久化模式仍需确认才能清除坏档或覆盖进行中对局', async () => {
    const badRaw = '{corrupted-shared-slot'
    window.localStorage.setItem(SAVE_KEY, badRaw)
    const a = mountTracked()
    await settle()
    // 坏档：新局被拦截并进入"存档无法读取"，原始内容保留
    expect(a.session().status.value).toBe('invalid-save')
    expect(await a.session().startNewGame()).toBe('blocked')
    expect(window.localStorage.getItem(SAVE_KEY)).toBe(badRaw)
    // 用户明确确认后才清除并新开
    a.session().clearInvalidSaveAndStart()
    await settle()
    expect(a.session().status.value).toBe('playing')
    expect(loadSaveEnvelope(window.localStorage.getItem(SAVE_KEY)!).ok).toBe(true)
    a.session().exitToEntry()
    await settle()

    // 进行中的对局：另一页需要按当前签名确认后才能覆盖
    const b = mountTracked()
    await settle()
    expect(b.session().status.value).toBe('entry')
    const rawBefore = window.localStorage.getItem(SAVE_KEY)
    expect(await b.session().startNewGame()).toBe('needs-confirmation')
    expect(window.localStorage.getItem(SAVE_KEY), '未确认不得覆盖').toBe(rawBefore)
    expect(await b.session().startNewGame(b.session().currentSlotSignature())).toBe('started')
    expect(window.localStorage.getItem(SAVE_KEY)).not.toBe(rawBefore)
  })
})
