import type { GameState } from '#shared/game'
// @vitest-environment happy-dom
// 问题 4 回归：pagehide 释放锁后，从历史缓存（bfcache）返回必须重新争取锁、
// 读取最新存档并恢复可操作状态；旧请求不得执行或触发兜底；未取得锁则显示只读。
// 说明：这里用模拟事件（pagehide / pageshow persisted）覆盖状态机；
// 真实浏览器中附加 CDP/DevTools 会话会禁用 Chrome 的 bfcache，无法观测真实还原，
// 已用真实 Web Locks 配合同样的 pagehide / persisted pageshow 事件验证到锁与状态恢复。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enumerateCandidatesFromState, projectForAi } from '#shared/game'
import { SAVE_KEY } from '~/composables/useGamePersistence'
import { cardOf, makeGame, submitOk } from '../rules/helpers'
import { FakeLockManager, installLocks, mountSession, settle } from './helpers'

const WRITER = 'cccccccc-dddd-4eee-8fff-000000000000'

/** 构造 p1（AI）行动且候选 ≥ 2 的确定局面。 */
function aiTurnState(): GameState {
  const base = makeGame({
    dealerId: 'p3',
    openingId: cardOf({ kind: 'number', color: 'red', value: 5 }),
    hands: {
      p0: ['red-1-2', 'blue-9-1', 'green-9-1', 'yellow-9-1', 'blue-8-1', 'green-8-1', 'wild-4'],
      p1: ['blue-5-2', 'red-3-2', 'green-skip-2', 'yellow-reverse-1', 'wild-1', 'wild-draw-four-1', 'blue-9-2'],
      p2: ['green-1-2', 'green-2-2', 'green-3-2', 'green-4-2', 'green-5-2', 'green-6-2', 'green-7-2'],
      p3: ['yellow-1-2', 'yellow-2-2', 'yellow-3-2', 'yellow-4-2', 'yellow-5-2', 'yellow-6-2', 'yellow-7-2'],
    },
  })
  const state = submitOk(base, 'p0', { type: 'play', cardId: 'red-1-2', declareUno: false })
  expect(state.currentPlayerId).toBe('p1')
  expect(enumerateCandidatesFromState(state)!.length).toBeGreaterThanOrEqual(2)
  return state
}

function writeSave(state: GameState) {
  window.localStorage.setItem(SAVE_KEY, JSON.stringify({
    schemaVersion: 1,
    savedAt: '2026-09-20T00:00:00.000Z',
    writerId: WRITER,
    state,
  }))
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
void projectForAi
