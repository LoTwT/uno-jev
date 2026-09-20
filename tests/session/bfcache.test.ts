import type { GameState } from '#shared/game'
// @vitest-environment happy-dom
// 问题 4 回归：pagehide 释放锁后，从历史缓存（bfcache）返回必须重新争取锁、
// 读取最新存档并恢复可操作状态；旧请求不得执行或触发兜底；未取得锁则显示只读。
// 第二轮审查问题 1 回归：恢复路径按 controlMode 与 saveHealth 区分——
// 临时对局与 memory-only 保留内存进度且不依赖锁；failed 保留未保存进度并暂停推进；
// 只有需要继续持久化的已保存对局才重新取锁、加载最新存档。
// 说明：这里用模拟事件（pagehide / pageshow persisted）覆盖状态机；
// 真实浏览器中附加 CDP/DevTools 会话会禁用 Chrome 的 bfcache，无法观测真实还原，
// 已用真实 Web Locks 配合同样的 pagehide / persisted pageshow 事件验证到锁与状态恢复。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enumerateCandidatesFromState, loadSaveEnvelope, projectForAi } from '#shared/game'
import { SAVE_KEY } from '~/composables/useGamePersistence'
import { cardOf, makeGame, mulberry32, submitOk } from '../rules/helpers'
import { FakeLockManager, FakeStorage, installLocks, installStorage, mountSession, settle } from './helpers'

const WRITER = 'cccccccc-dddd-4eee-8fff-000000000000'
const OTHER_WRITER = 'dddddddd-eeee-4fff-8aaa-111111111111'
/** 固定随机输入：临时对局开局（庄家与洗牌）可重复，p0 先手。 */
const HUMAN_FIRST_SEED = 36

/** 构造 p0（真人）行动、抽牌必然合法的确定局面。 */
function humanTurnState(): GameState {
  const state = makeGame({
    dealerId: 'p3',
    openingId: cardOf({ kind: 'number', color: 'red', value: 5 }),
    hands: {
      p0: ['red-1-2', 'blue-9-1', 'green-9-1', 'yellow-9-1', 'blue-8-1', 'green-8-1', 'wild-4'],
      p1: ['blue-5-2', 'red-3-2', 'green-skip-2', 'yellow-reverse-1', 'wild-1', 'wild-draw-four-1', 'blue-9-2'],
      p2: ['green-1-2', 'green-2-2', 'green-3-2', 'green-4-2', 'green-5-2', 'green-6-2', 'green-7-2'],
      p3: ['yellow-1-2', 'yellow-2-2', 'yellow-3-2', 'yellow-4-2', 'yellow-5-2', 'yellow-6-2', 'yellow-7-2'],
    },
  })
  expect(state.currentPlayerId).toBe('p0')
  expect(state.phase.kind).toBe('turn')
  // 把可出的红 9 放到抽牌堆末尾：下一次抽牌必然进入 after-draw，动作序列确定
  const pile = [...state.drawPile]
  pile.splice(pile.indexOf('red-9-2'), 1)
  pile.push('red-9-2')
  state.drawPile = pile
  return state
}

type SessionGetter = ReturnType<typeof mountSession>['session']

/** 提交一个必然合法的真人动作，真实推进会话内存状态。 */
function humanAction(session: SessionGetter) {
  const state = session().state.value!
  expect(state.currentPlayerId, '当前应为真人回合').toBe('p0')
  if (state.phase.kind === 'after-draw') {
    session().keepDrawn()
    return
  }
  expect(state.phase.kind).toBe('turn')
  session().drawOne()
}

/** 构造 p1（AI）行动且候选 ≥ 2 的确定局面。 */
function aiTurnState(): GameState {
  const state = submitOk(humanTurnState(), 'p0', { type: 'play', cardId: 'red-1-2', declareUno: false })
  expect(state.currentPlayerId).toBe('p1')
  expect(enumerateCandidatesFromState(state)!.length).toBeGreaterThanOrEqual(2)
  return state
}

function writeSave(state: GameState, writerId = WRITER) {
  window.localStorage.setItem(SAVE_KEY, JSON.stringify({
    schemaVersion: 1,
    savedAt: '2026-09-20T00:00:00.000Z',
    writerId,
    state,
  }))
}

/** 槽位当前保存的 revision；槽位不可读时返回 null。 */
function slotRevision(): number | null {
  const raw = window.localStorage.getItem(SAVE_KEY)
  if (raw === null) {
    return null
  }
  const parsed = loadSaveEnvelope(raw)
  return parsed.ok ? parsed.envelope.state.revision : null
}

function dispatchPageShow(persisted: boolean) {
  const event = new Event('pageshow')
  Object.defineProperty(event, 'persisted', { value: persisted })
  window.dispatchEvent(event)
}

interface PendingRequest {
  resolve: (response: Response) => void
  body: { decisionId: string, gameId: string, revision: number, actorId: string }
}

let lockManager: FakeLockManager
let restoreLocks: () => void
let pending: PendingRequest[]

function installHangingFetch() {
  pending = []
  vi.stubGlobal('fetch', ((_url: string | URL | Request, init?: RequestInit) => {
    return new Promise<Response>((resolve) => {
      pending.push({ resolve, body: JSON.parse(String(init?.body)) })
    })
  }) as typeof fetch)
}

beforeEach(() => {
  window.localStorage.clear()
  lockManager = new FakeLockManager()
  restoreLocks = installLocks(lockManager)
  installHangingFetch()
})

afterEach(() => {
  vi.unstubAllGlobals()
  // 恢复 Math.random 等替身：随机输入不泄漏到其他用例
  vi.restoreAllMocks()
  restoreLocks()
})

describe('bfcache 恢复（问题 4，模拟事件）', () => {
  it('pagehide 取消在途请求并释放锁；pageshow 重新取锁、读取最新存档并恢复推进', async () => {
    const saved = aiTurnState()
    writeSave(saved)

    const { wrapper, session } = mountSession()
    await settle()
    session().continueGame()
    await settle()
    expect(session().status.value).toBe('playing')
    expect(pending).toHaveLength(1)
    expect(session().aiTurn.inFlight.value).not.toBeNull()

    // 进入历史缓存：取消并作废在途请求、释放锁
    window.dispatchEvent(new Event('pagehide'))
    await settle()
    expect(session().aiTurn.inFlight.value, '在途请求已作废').toBeNull()
    expect(lockManager.isHeld(), 'pagehide 释放锁').toBe(false)

    // 从 bfcache 返回：重新取锁并读取最新存档，恢复可操作状态
    dispatchPageShow(true)
    await settle()
    expect(lockManager.isHeld(), '重新取得锁').toBe(true)
    expect(session().status.value).toBe('playing')
    expect(session().state.value?.gameId).toBe(saved.gameId)
    expect(pending, '恢复后重新调度 AI 决策').toHaveLength(2)

    // 旧请求的晚到响应不得执行：用当前存档状态构造合法响应后晚到
    const stale = pending[0]!
    const candidates = enumerateCandidatesFromState(session().state.value!)!
    const revisionBefore = session().state.value!.revision
    stale.resolve(new Response(JSON.stringify({
      protocolVersion: 1,
      gameId: stale.body.gameId,
      revision: stale.body.revision,
      decisionId: stale.body.decisionId,
      actorId: stale.body.actorId,
      actionId: candidates[0]!.id,
      source: 'jev',
      model: 'jev-1.13.0',
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    await settle()
    expect(session().state.value!.revision, '旧响应不得推进对局').toBe(revisionBefore)

    wrapper.unmount()
  })

  it('返回时锁被另一标签页占用：显示只读状态，不恢复操作', async () => {
    const saved = aiTurnState()
    writeSave(saved)

    const a = mountSession()
    await settle()
    a.session().continueGame()
    await settle()
    window.dispatchEvent(new Event('pagehide'))
    await settle()
    expect(lockManager.isHeld()).toBe(false)

    // 另一标签页在隐藏期间接管控制权
    const b = mountSession()
    await settle()
    expect(b.session().status.value).toBe('entry')

    dispatchPageShow(true)
    await settle()
    expect(a.session().status.value).toBe('readonly-locked')
    expect(a.session().lock.held.value).toBe(false)

    a.wrapper.unmount()
    b.wrapper.unmount()
  })

  it('pageshow 非 persisted（普通加载）不触发恢复流程', async () => {
    const saved = aiTurnState()
    writeSave(saved)
    const { wrapper, session } = mountSession()
    await settle()
    session().continueGame()
    await settle()
    const before = session().status.value

    dispatchPageShow(false)
    await settle()
    expect(session().status.value).toBe(before)

    wrapper.unmount()
  })

  it('入口状态返回时刷新存档展示，不进入对局', async () => {
    const saved = aiTurnState()
    writeSave(saved)
    const { wrapper, session } = mountSession()
    await settle()
    expect(session().status.value).toBe('entry')

    dispatchPageShow(true)
    await settle()
    expect(session().status.value).toBe('entry')
    expect(session().state.value).toBeNull()
    expect(session().entrySave.value.status).toBe('valid')

    wrapper.unmount()
  })
})

describe('恢复路径按控制模式与保存状态区分（第二轮审查问题 1）', () => {
  // 断言失败时也要卸载：未卸载的会话仍监听 pageshow，会持有锁并干扰后续用例
  const mounted: Array<ReturnType<typeof mountSession>['wrapper']> = []
  function mountTracked() {
    const session = mountSession()
    mounted.push(session.wrapper)
    return session
  }
  afterEach(() => {
    for (const wrapper of mounted.splice(0)) {
      wrapper.unmount()
    }
  })

  it('临时对局（无 Web Locks）：恢复后保留当前状态，不进入 no-lock-browser', async () => {
    const restoreNoLocks = installLocks(null)
    try {
      // 固定随机输入：临时对局的开局（庄家与洗牌）可重复，真人先手
      vi.spyOn(Math, 'random').mockImplementation(mulberry32(HUMAN_FIRST_SEED))
      const { session } = mountTracked()
      await settle()
      expect(session().status.value).toBe('no-lock-browser')

      session().startTempGame()
      await settle()
      expect(session().status.value).toBe('playing')
      const gameId = session().state.value!.gameId
      const revision = session().state.value!.revision

      window.dispatchEvent(new Event('pagehide'))
      await settle()
      dispatchPageShow(true)
      await settle()

      expect(session().status.value, '临时对局不因缺少 Web Locks 而丢失').toBe('playing')
      expect(session().state.value?.gameId, '保留同一局').toBe(gameId)
      expect(session().state.value!.revision, '不丢进度').toBeGreaterThanOrEqual(revision)
      expect(session().persistence.saveHealth.value).toBe('memory-only')
      expect(session().lock.held.value, '临时对局不依赖锁').toBe(false)

      // 临时对局继续可推进：不依赖锁，也不写共享槽位
      expect(session().state.value!.currentPlayerId, '该种子下真人先手').toBe('p0')
      humanAction(session)
      await settle()
      expect(session().state.value!.revision).toBeGreaterThan(revision)
      expect(window.localStorage.getItem(SAVE_KEY), '临时对局不读写共享槽位').toBeNull()
    }
    finally {
      restoreNoLocks()
    }
  })

  it('仅此页继续（memory-only）：恢复后保留未保存的内存进度，不回退到旧存档', async () => {
    const fake = new FakeStorage()
    const restoreStorage = installStorage(fake)
    try {
      writeSave(humanTurnState())
      const { session } = mountTracked()
      await settle()
      session().continueGame()
      await settle()
      expect(session().status.value).toBe('playing')

      // 真实动作推进内存状态，写入失败（配额不足）
      fake.failSet = true
      humanAction(session)
      await settle()
      const memoryRevision = session().state.value!.revision
      expect(memoryRevision).toBe(1)
      expect(session().persistence.saveHealth.value).toBe('failed')

      // 用户选择"仅在此页继续"，再推进一次（内存模式不再写槽位）
      session().continueInMemoryOnly()
      await settle()
      humanAction(session)
      await settle()
      const progressed = session().state.value!.revision
      expect(progressed).toBe(memoryRevision + 1)
      expect(slotRevision(), '内存模式不写共享槽位').toBe(0)

      window.dispatchEvent(new Event('pagehide'))
      await settle()
      dispatchPageShow(true)
      await settle()

      expect(session().status.value, 'memory-only 恢复后仍可操作').toBe('playing')
      expect(session().state.value!.revision, '不回退到旧存档').toBe(progressed)
      expect(session().persistence.saveHealth.value).toBe('memory-only')
      expect(slotRevision()).toBe(0)
    }
    finally {
      restoreStorage()
    }
  })

  it('保存失败（failed）：恢复后保留未保存的内存进度，仍暂停自动推进并保留重试入口', async () => {
    const fake = new FakeStorage()
    const restoreStorage = installStorage(fake)
    try {
      writeSave(humanTurnState())
      const { session } = mountTracked()
      await settle()
      session().continueGame()
      await settle()
      expect(session().persistence.saveHealth.value).toBe('ok')

      // 真实动作推进内存状态；写入失败时保留旧槽位
      fake.failSet = true
      humanAction(session)
      await settle()
      const memoryRevision = session().state.value!.revision
      expect(memoryRevision).toBe(1)
      expect(session().persistence.saveHealth.value).toBe('failed')
      expect(slotRevision()).toBe(0)

      window.dispatchEvent(new Event('pagehide'))
      await settle()
      dispatchPageShow(true)
      await settle()

      expect(session().status.value).toBe('playing')
      expect(session().state.value!.revision, '保留未保存的内存进度').toBe(memoryRevision)
      expect(session().persistence.saveHealth.value).toBe('failed')
      expect(session().aiTurn.inFlight.value, 'failed 恢复后不自动推进').toBeNull()
      expect(session().lock.held.value, '需要继续持久化的会话重新取锁').toBe(true)
      expect(slotRevision(), '恢复过程不写入槽位').toBe(0)

      // "重试保存"入口在恢复后仍可用：存储恢复后写入当前内存进度
      fake.failSet = false
      session().retrySave()
      await settle()
      expect(session().persistence.saveHealth.value).toBe('ok')
      expect(slotRevision()).toBe(memoryRevision)
    }
    finally {
      restoreStorage()
    }
  })

  it('保存失败 + 槽位被外部改写：恢复时停止写入并保留内存进度，用户可选择仅在此页继续', async () => {
    const fake = new FakeStorage()
    const restoreStorage = installStorage(fake)
    try {
      writeSave(humanTurnState())
      const { session } = mountTracked()
      await settle()
      session().continueGame()
      await settle()

      fake.failSet = true
      humanAction(session)
      await settle()
      const memoryRevision = session().state.value!.revision
      expect(session().persistence.saveHealth.value).toBe('failed')

      // 进入历史缓存（释放锁）后，另一标签页写入不同的进行中对局
      window.dispatchEvent(new Event('pagehide'))
      await settle()
      fake.failSet = false
      const external = structuredClone(humanTurnState())
      external.revision = 5
      writeSave(external, OTHER_WRITER)

      dispatchPageShow(true)
      await settle()
      expect(session().status.value, '外部改写后不继续写入').toBe('slot-conflict')
      expect(session().slotProblemKind.value).toBe('conflict')
      expect(session().state.value!.revision, '保留本页未保存的进度').toBe(memoryRevision)
      expect(slotRevision(), '不得覆盖外部存档').toBe(5)

      // 用户选择保留本页进度：进入内存模式继续，不加载外部存档
      session().continueInMemoryOnly()
      await settle()
      expect(session().status.value).toBe('playing')
      expect(session().persistence.saveHealth.value).toBe('memory-only')
      expect(session().state.value!.revision).toBe(memoryRevision)
      expect(slotRevision()).toBe(5)
    }
    finally {
      restoreStorage()
    }
  })

  it('保存失败 + 恢复时锁被其他标签页占用：不写入共享槽位，保留内存进度供用户选择', async () => {
    const fake = new FakeStorage()
    const restoreStorage = installStorage(fake)
    try {
      writeSave(humanTurnState())
      const a = mountTracked()
      await settle()
      a.session().continueGame()
      await settle()

      fake.failSet = true
      humanAction(a.session)
      await settle()
      const memoryRevision = a.session().state.value!.revision
      expect(a.session().persistence.saveHealth.value).toBe('failed')

      // 页 A 进入历史缓存释放锁；页 B 接管控制权并保持持锁
      window.dispatchEvent(new Event('pagehide'))
      await settle()
      const b = mountTracked()
      await settle()
      expect(b.session().lock.held.value).toBe(true)

      dispatchPageShow(true)
      await settle()
      expect(a.session().status.value, '保留内存进度而不是只读回退').toBe('playing')
      expect(a.session().state.value!.revision).toBe(memoryRevision)
      expect(a.session().lock.held.value).toBe(false)

      // 没有控制权时"重试保存"不得写入共享槽位
      const slotBefore = window.localStorage.getItem(SAVE_KEY)
      fake.failSet = false
      a.session().retrySave()
      await settle()
      expect(window.localStorage.getItem(SAVE_KEY), '未持锁不得写入').toBe(slotBefore)
      expect(a.session().persistence.saveHealth.value).toBe('failed')

      // 用户选择"仅在此页继续"：无需控制权也能继续推进内存进度
      a.session().continueInMemoryOnly()
      await settle()
      expect(a.session().status.value).toBe('playing')
      expect(a.session().persistence.saveHealth.value).toBe('memory-only')
      const before = a.session().state.value!.revision
      humanAction(a.session)
      await settle()
      expect(a.session().state.value!.revision).toBe(before + 1)
      expect(window.localStorage.getItem(SAVE_KEY)).toBe(slotBefore)
    }
    finally {
      restoreStorage()
    }
  })
})
void projectForAi
