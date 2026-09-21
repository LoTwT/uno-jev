import type { GameState, LegalAction } from '#shared/game'
// @vitest-environment happy-dom
// A3（客户端）：mock 成功 / 429 / 529 / 401 / 422 / 5xx / 非 JSON / 超时 / 断网 /
// 重复与乱序返回——该兜底时只执行一次，过期时既不执行也不兜底；单候选不联网
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { applyAction, createGame as createGameFn, enumerateCandidatesFromState, listLegalActions, projectForAi } from '#shared/game'
import { useAiTurn } from '~/composables/useAiTurn'

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 找到一个 AI 行动且候选 ≥ 2 的状态。 */
function buildAiTurnState(): GameState {
  for (let seed = 1; seed < 300; seed++) {
    let state: GameState = {
      ...({} as GameState),
    }
    void state
    // 随机创建并推进到 AI 行动
    const { createGame } = require0()
    state = createGame({ random: mulberry32(seed), gameId: '12345678-1234-5678-1234-567812345678' })
    for (let step = 0; step < 60; step++) {
      if (state.phase.kind === 'finished') {
        break
      }
      if (state.currentPlayerId !== 'p0') {
        const candidates = enumerateCandidatesFromState(state)
        if (candidates && candidates.length >= 2) {
          return state
        }
      }
      const random = mulberry32(seed * 100 + step)
      const actions = listLegalActions(state, state.currentPlayerId)
      const action = actions[Math.floor(random() * actions.length)]! as LegalAction
      const result = applyAction(state, { actorId: state.currentPlayerId, gameId: state.gameId, expectedRevision: state.revision, action })
      if (!result.ok) {
        break
      }
      state = result.state
    }
  }
  throw new Error('无法构造 AI 行动状态')
}

// 延迟 require 避免循环导入问题（直接顶层导入亦可）
function require0() {
  return { createGame: createGameFn }
}

interface Submitted {
  actorId: string
  action: LegalAction
  meta: { aiSource: string, fallbackReason?: string } | undefined
}

function mountAiTurn(initial: GameState, credential = { source: 'site' as const, personalKey: null as string | null }) {
  const stateRef = { current: initial }
  const submitted: Submitted[] = []
  const fetchCalls: Array<{ url: string, body: unknown }> = []
  let canAdvanceValue = true

  const deps = {
    getState: () => stateRef.current,
    canAdvance: () => canAdvanceValue,
    getCredential: () => credential,
    submitAction: (actorId: string, action: LegalAction, meta: { aiSource: 'jev' | 'forced' | 'fallback', fallbackReason?: string }) => {
      submitted.push({ actorId, action, meta })
      const result = applyAction(stateRef.current, { actorId: actorId as GameState['currentPlayerId'], gameId: stateRef.current.gameId, expectedRevision: stateRef.current.revision, action }, meta ? { meta: { aiSource: meta.aiSource, ...(meta.fallbackReason ? { fallbackReason: meta.fallbackReason } : {}) } } : undefined)
      if (result.ok) {
        stateRef.current = result.state
        return true
      }
      return false
    },
    timeoutMs: 30,
  }
  let exposed!: ReturnType<typeof useAiTurn>
  const host = defineComponent({
    setup() {
      exposed = useAiTurn(deps)
      return () => h('div')
    },
  })
  const wrapper = mount(host)
  return {
    wrapper,
    controller: () => exposed,
    submitted,
    fetchCalls,
    state: stateRef,
    setCanAdvance: (v: boolean) => { canAdvanceValue = v },
  }
}

/** mock fetch：按序返回预设响应。 */
function queueResponses(responses: Array<() => Promise<Response>>) {
  let index = 0
  const calls: Array<{ url: string, body: unknown }> = []
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null })
    const responder = responses[Math.min(index, responses.length - 1)]!
    index++
    return responder()
  }) as typeof fetch
  return { impl, calls }
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return () => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } }))
}

async function settle(ms = 0) {
  await new Promise(resolve => setTimeout(resolve, ms))
  await new Promise(resolve => setTimeout(resolve, 0))
}

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('aI 决策调度（A3 客户端）', () => {
  it('mock 成功：应用 Jev 选择并标记来源 jev', async () => {
    const state = buildAiTurnState()
    const candidates = enumerateCandidatesFromState(state)!
    const harness = mountAiTurn(state)
    const { impl, calls } = queueResponses([jsonResponse(200, {
      protocolVersion: 2,
      gameId: state.gameId,
      revision: state.revision,
      decisionId: 'PLACEHOLDER',
      actorId: state.currentPlayerId,
      actionId: candidates[0]!.id,
      source: 'jev',
      model: 'jev-1.13.0',
    })])
    // decisionId 由请求生成，响应需要回显它：动态包装
    let latestDecisionId = ''
    const wrappedImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      latestDecisionId = body.decisionId
      harness.fetchCalls.push({ url: String(url), body })
      const parsed = JSON.parse(String(init?.body))
      const responder = jsonResponse(200, {
        protocolVersion: 2,
        gameId: parsed.gameId,
        revision: parsed.revision,
        decisionId: parsed.decisionId,
        actorId: parsed.actorId,
        actionId: candidates[0]!.id,
        source: 'jev',
        model: 'jev-1.13.0',
      })
      return responder()
    }) as typeof fetch
    vi.stubGlobal('fetch', wrappedImpl)
    void impl
    void calls

    harness.controller().schedule()
    await settle(30)

    expect(harness.fetchCalls).toHaveLength(1)
    expect(harness.fetchCalls[0]!.url).toBe('/api/ai/decision')
    // 请求体合同
    const body = harness.fetchCalls[0]!.body as Record<string, unknown>
    expect(body.protocolVersion).toBe(2)
    expect(body.gameId).toBe(state.gameId)
    expect(body.decisionId).toBe(latestDecisionId)
    expect(body.view).toEqual(projectForAi(state, state.currentPlayerId as 'p1'))
    // 应用了 Jev 的选择
    expect(harness.submitted).toHaveLength(1)
    expect(harness.submitted[0]!.meta!.aiSource).toBe('jev')
    expect(harness.state.current.revision).toBe(state.revision + 1)
    const sourceEvent = harness.state.current.recentEvents.find(e => e.type === 'decision-source')
    expect(sourceEvent).toMatchObject({ source: 'jev' })
    harness.wrapper.unmount()
  })

  it('单候选直接执行并记为 forced，不联网', async () => {
    // 找一个 AI 无牌可出的状态（候选只有 draw_one）
    let state: GameState | null = null
    for (let seed = 1; seed < 300 && !state; seed++) {
      let s = createGameFn({ random: mulberry32(seed), gameId: '12345678-1234-5678-1234-567812345678' })
      for (let step = 0; step < 80; step++) {
        if (s.phase.kind === 'finished') {
          break
        }
        if (s.currentPlayerId !== 'p0') {
          const candidates = enumerateCandidatesFromState(s)
          if (candidates && candidates.length === 1 && candidates[0]!.id === 'draw_one') {
            state = s
            break
          }
        }
        const random = mulberry32(seed * 100 + step)
        const actions = listLegalActions(s, s.currentPlayerId)
        const action = actions[Math.floor(random() * actions.length)]! as LegalAction
        const result = applyAction(s, { actorId: s.currentPlayerId, gameId: s.gameId, expectedRevision: s.revision, action })
        if (!result.ok) {
          break
        }
        s = result.state
      }
    }
    expect(state).not.toBeNull()

    const harness = mountAiTurn(state!)
    const fetchSpy = vi.fn(() => new Promise<Response>(() => {}))
    vi.stubGlobal('fetch', fetchSpy)

    harness.controller().schedule()
    await settle(20)

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(harness.submitted).toHaveLength(1)
    expect(harness.submitted[0]!.meta!.aiSource).toBe('forced')
    expect(harness.submitted[0]!.action.type).toBe('draw-one')
    harness.wrapper.unmount()
  })

  const errorCases: Array<[string, number, unknown, string, string]> = [
    ['上游 429（带 Retry-After）', 429, { error: { code: 'ai_rate_limited' }, decisionId: 'x' }, 'rate_limited', '429'],
    ['上游 529', 529, { error: { code: 'ai_rate_limited' } }, 'rate_limited', ''],
    ['上游 401 → 503 会话暂停', 503, { error: { code: 'ai_unavailable' } }, 'ai_unavailable', ''],
    ['上游 422 → 502', 502, { error: { code: 'ai_upstream_error' } }, 'upstream_error', ''],
    ['上游 500 → 502', 502, { error: { code: 'ai_upstream_error' } }, 'upstream_error', ''],
    ['非 JSON 错误页', 502, { error: { code: 'ai_invalid_response' } }, 'invalid_response', ''],
    ['超时（短超时 + 悬挂 fetch）', 0, null, 'timeout', ''],
  ]

  for (const [name, status, body, reason, retryAfter] of errorCases) {
    it(`${name} → 当次兜底 ${reason}，且只执行一次`, async () => {
      const state = buildAiTurnState()
      const harness = mountAiTurn(state)
      if (status === 0) {
        // 超时：悬挂并响应 abort
        vi.stubGlobal('fetch', ((url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
          harness.fetchCalls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null })
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
        })) as typeof fetch)
      }
      else {
        vi.stubGlobal('fetch', (async (url: string | URL | Request, init?: RequestInit) => {
          harness.fetchCalls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null })
          return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...(retryAfter ? { 'retry-after': retryAfter } : {}) } })
        }) as typeof fetch)
      }

      harness.controller().schedule()
      await settle(120)

      expect(harness.submitted, name).toHaveLength(1)
      expect(harness.submitted[0]!.meta!.aiSource, name).toBe('fallback')
      expect(harness.submitted[0]!.meta!.fallbackReason, name).toBe(reason)
      // 决策来源事件记录了兜底原因
      const sourceEvent = harness.state.current.recentEvents.find(e => e.type === 'decision-source')
      expect(sourceEvent, name).toMatchObject({ source: 'fallback', reason })
      harness.wrapper.unmount()
    })
  }

  it('断网（navigator.onLine=false）直接兜底，不发请求', async () => {
    const state = buildAiTurnState()
    const harness = mountAiTurn(state)
    const onlineGetter = Object.getOwnPropertyDescriptor(Navigator.prototype, 'onLine')
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    try {
      const fetchSpy = vi.fn(() => new Promise<Response>(() => {}))
      vi.stubGlobal('fetch', fetchSpy)
      harness.controller().schedule()
      await settle(20)
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(harness.submitted).toHaveLength(1)
      expect(harness.submitted[0]!.meta).toMatchObject({ aiSource: 'fallback', fallbackReason: 'offline' })
    }
    finally {
      delete (navigator as unknown as { onLine?: boolean }).onLine
      if (onlineGetter) {
        Object.defineProperty(Navigator.prototype, 'onLine', onlineGetter)
      }
    }
    harness.wrapper.unmount()
  })

  it('过期响应（revision 已变化）：既不执行也不兜底', async () => {
    const state = buildAiTurnState()
    const harness = mountAiTurn(state)
    let releaseResponse!: (value: Response) => void
    vi.stubGlobal('fetch', ((url: string | URL | Request, init?: RequestInit) => {
      harness.fetchCalls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null })
      return new Promise<Response>((resolve) => {
        releaseResponse = resolve
      })
    }) as typeof fetch)

    harness.controller().schedule()
    await settle(10)
    expect(harness.fetchCalls).toHaveLength(1)

    // 在途期间状态被外部改变（例如另一来源推进了局面）
    const actions = listLegalActions(harness.state.current, harness.state.current.currentPlayerId)
    const advanced = applyAction(harness.state.current, { actorId: harness.state.current.currentPlayerId, gameId: harness.state.current.gameId, expectedRevision: harness.state.current.revision, action: actions[0]! })
    expect(advanced.ok).toBe(true)
    if (advanced.ok) {
      harness.state.current = advanced.state
    }

    // 晚到的成功响应
    const body = harness.fetchCalls[0]!.body as { decisionId: string, gameId: string, revision: number, actorId: string }
    const candidatesBefore = enumerateCandidatesFromState(state)!
    releaseResponse(new Response(JSON.stringify({
      protocolVersion: 2,
      gameId: body.gameId,
      revision: body.revision,
      decisionId: body.decisionId,
      actorId: body.actorId,
      actionId: candidatesBefore[0]!.id,
      source: 'jev',
      model: 'jev-1.13.0',
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    await settle(30)

    // 既不执行（除手动推进的那次外无新提交）也不触发兜底
    expect(harness.submitted).toHaveLength(0)
    harness.wrapper.unmount()
  })

  it('重复 / 乱序响应：作废代次后晚到的响应全部丢弃', async () => {
    const state = buildAiTurnState()
    const harness = mountAiTurn(state)
    let releaseFirst!: (value: Response) => void
    vi.stubGlobal('fetch', ((url: string | URL | Request, init?: RequestInit) => {
      harness.fetchCalls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null })
      return new Promise<Response>((resolve) => {
        releaseFirst = resolve
      })
    }) as typeof fetch)

    harness.controller().schedule()
    await settle(10)

    // 取消（页面隐藏 / 失锁）：作废代次
    harness.controller().cancelAll()
    const body = harness.fetchCalls[0]!.body as { decisionId: string, gameId: string, revision: number, actorId: string }
    const candidatesBefore = enumerateCandidatesFromState(state)!
    releaseFirst(new Response(JSON.stringify({
      protocolVersion: 2,
      gameId: body.gameId,
      revision: body.revision,
      decisionId: body.decisionId,
      actorId: body.actorId,
      actionId: candidatesBefore[0]!.id,
      source: 'jev',
      model: 'jev-1.13.0',
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    await settle(30)
    expect(harness.submitted).toHaveLength(0)
    harness.wrapper.unmount()
  })

  it('429 冷却期内的新决策直接兜底且不再发请求；冷却语义可见', async () => {
    const state = buildAiTurnState()
    const harness = mountAiTurn(state)
    vi.stubGlobal('fetch', (async (url: string | URL | Request, init?: RequestInit) => {
      harness.fetchCalls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null })
      return new Response(JSON.stringify({ error: { code: 'ai_rate_limited' }, decisionId: 'x' }), { status: 429, headers: { 'retry-after': '30', 'content-type': 'application/json' } })
    }) as typeof fetch)

    harness.controller().schedule()
    await settle(30)
    expect(harness.submitted).toHaveLength(1)
    expect(harness.submitted[0]!.meta!.fallbackReason).toBe('rate_limited')
    expect(harness.controller().cooldownUntil.value).toBeGreaterThan(Date.now())

    // 冷却期内的新 AI 决策（把局面轮转到另一个 AI）：不再联网，直接兜底
    const second = harness.state.current
    if (second.currentPlayerId !== 'p0') {
      harness.controller().schedule()
      await settle(20)
      expect(harness.fetchCalls).toHaveLength(1)
      expect(harness.submitted).toHaveLength(2)
      expect(harness.submitted[1]!.meta!.fallbackReason).toBe('rate_limited')
    }
    harness.wrapper.unmount()
  })

  it('503 后本页面会话暂停 Jev；重试 AI 恢复后续决策', async () => {
    const state = buildAiTurnState()
    const harness = mountAiTurn(state)
    vi.stubGlobal('fetch', (async (url: string | URL | Request, init?: RequestInit) => {
      harness.fetchCalls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null })
      return new Response(JSON.stringify({ error: { code: 'ai_unavailable' } }), { status: 503, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch)

    harness.controller().schedule()
    await settle(30)
    expect(harness.controller().jevPaused.value).toBe(true)
    expect(harness.submitted[0]!.meta!.fallbackReason).toBe('ai_unavailable')

    // 暂停期间新决策继续兜底、不联网
    if (harness.state.current.currentPlayerId !== 'p0') {
      harness.controller().schedule()
      await settle(20)
      expect(harness.fetchCalls).toHaveLength(1)
      expect(harness.submitted[1]!.meta!.fallbackReason).toBe('ai_unavailable')
    }

    // 用户点击"重试 AI"：恢复后续决策（不再请求已落地动作）
    const candidates = enumerateCandidatesFromState(harness.state.current)
    if (harness.state.current.currentPlayerId !== 'p0' && candidates && candidates.length >= 2) {
      vi.stubGlobal('fetch', (async (url: string | URL | Request, init?: RequestInit) => {
        harness.fetchCalls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null })
        const parsed = JSON.parse(String(init?.body))
        return new Response(JSON.stringify({
          protocolVersion: 2,
          gameId: parsed.gameId,
          revision: parsed.revision,
          decisionId: parsed.decisionId,
          actorId: parsed.actorId,
          actionId: candidates[0]!.id,
          source: 'jev',
          model: 'jev-1.13.0',
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }) as typeof fetch)
      harness.controller().resumeJev()
      await settle(30)
      expect(harness.controller().jevPaused.value).toBe(false)
      expect(harness.submitted.at(-1)!.meta!.aiSource).toBe('jev')
    }
    harness.wrapper.unmount()
  })

  it('页面不可推进（canAdvance=false）时不调度', async () => {
    const state = buildAiTurnState()
    const harness = mountAiTurn(state)
    harness.setCanAdvance(false)
    const fetchSpy = vi.fn(() => new Promise<Response>(() => {}))
    vi.stubGlobal('fetch', fetchSpy)
    harness.controller().schedule()
    await settle(20)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(harness.submitted).toHaveLength(0)
    harness.wrapper.unmount()
  })
})
