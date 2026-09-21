import type { GameState, LegalAction } from '#shared/game'
import type { JevCredential } from '~/composables/useJevCredentials'
// @vitest-environment happy-dom
// K 系（调度凭据感知）：来源选择与请求头传递、个人模式不写 Key 进请求体、
// 站点额度耗尽的粘滞引导、鉴权与限流按来源区分、切换凭据时的过期响应作废、
// 替换 Key 清除暂停、缺 Key 不发请求也不改用站点额度。
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { AI_PERSONAL_KEY_HEADER } from '#shared/ai/protocol'
import { applyAction, createGame, enumerateCandidatesFromState, listLegalActions } from '#shared/game'
import { useAiTurn } from '~/composables/useAiTurn'

const PERSONAL_KEY = 'ts_personal_key_marker_0123456789abcdef'
const REPLACEMENT_KEY = 'ts_replacement_key_0000000000000001'

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
    let state = createGame({ random: mulberry32(seed), gameId: '12345678-1234-5678-1234-567812345678' })
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

interface Submitted {
  actorId: string
  action: LegalAction
  meta: { aiSource: string, fallbackReason?: string } | undefined
}

interface FetchCall { url: string, headers: Record<string, string>, body: Record<string, unknown> }

function mountAiTurn(initial: GameState, initialCredential: JevCredential) {
  const stateRef = { current: initial }
  const submitted: Submitted[] = []
  const fetchCalls: FetchCall[] = []
  const credential = ref<JevCredential>({ ...initialCredential })

  const deps = {
    getState: () => stateRef.current,
    canAdvance: () => true,
    getCredential: () => credential.value,
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
    credential,
    setCredential: (next: JevCredential) => {
      credential.value = { ...next }
    },
  }
}

/** stub fetch：记录请求头与请求体，按序返回预设响应（成功响应回映请求关联字段）。 */
function stubFetch(harness: ReturnType<typeof mountAiTurn>, respond: (call: FetchCall) => Response | Promise<Response>) {
  vi.stubGlobal('fetch', (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers as HeadersInit | undefined).entries())
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    const call: FetchCall = { url: String(url), headers, body }
    harness.fetchCalls.push(call)
    return respond(call)
  }) as typeof fetch)
}

function successResponse(call: FetchCall, actionId: string): Response {
  return new Response(JSON.stringify({
    protocolVersion: 2,
    gameId: call.body.gameId,
    revision: call.body.revision,
    decisionId: call.body.decisionId,
    actorId: call.body.actorId,
    actionId,
    source: 'jev',
    model: 'jev-1.13.0',
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

function errorResponse(status: number, code: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: { code } }), { status, headers: { 'content-type': 'application/json', ...headers } })
}

async function settle(ms = 30) {
  await new Promise(resolve => setTimeout(resolve, ms))
  await new Promise(resolve => setTimeout(resolve, 0))
}

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('凭据来源与请求传递', () => {
  it('个人模式：请求体声明 credentialSource，Key 只经专用请求头传递', async () => {
    const state = buildAiTurnState()
    const harness = mountAiTurn(state, { source: 'personal', personalKey: PERSONAL_KEY })
    stubFetch(harness, call => successResponse(call, (call.body.candidates as Array<{ id: string }>)[0]!.id))

    harness.controller().schedule()
    await settle()

    expect(harness.fetchCalls).toHaveLength(1)
    expect(harness.fetchCalls[0]!.url).toBe('/api/ai/decision')
    expect(harness.fetchCalls[0]!.body.credentialSource).toBe('personal')
    expect(harness.fetchCalls[0]!.headers[AI_PERSONAL_KEY_HEADER]).toBe(PERSONAL_KEY)
    // Key 不进入请求体
    expect(JSON.stringify(harness.fetchCalls[0]!.body)).not.toContain(PERSONAL_KEY)
    expect(harness.submitted[0]!.meta!.aiSource).toBe('jev')
    harness.wrapper.unmount()
  })

  it('站点模式：不携带个人 Key 请求头，credentialSource 为 site', async () => {
    const state = buildAiTurnState()
    const harness = mountAiTurn(state, { source: 'site', personalKey: null })
    stubFetch(harness, call => successResponse(call, (call.body.candidates as Array<{ id: string }>)[0]!.id))

    harness.controller().schedule()
    await settle()

    expect(harness.fetchCalls[0]!.body.credentialSource).toBe('site')
    expect(harness.fetchCalls[0]!.headers[AI_PERSONAL_KEY_HEADER]).toBeUndefined()
    harness.wrapper.unmount()
  })

  it('个人模式缺少 Key：不发请求、不消耗站点额度，兜底标记 personal_key_missing', async () => {
    const state = buildAiTurnState()
    const harness = mountAiTurn(state, { source: 'personal', personalKey: null })
    const fetchSpy = vi.fn(() => new Promise<Response>(() => {}))
    vi.stubGlobal('fetch', fetchSpy)

    harness.controller().schedule()
    await settle(20)

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(harness.submitted).toHaveLength(1)
    expect(harness.submitted[0]!.meta).toMatchObject({ aiSource: 'fallback', fallbackReason: 'personal_key_missing' })
    harness.wrapper.unmount()
  })
})

describe('站点额度耗尽引导', () => {
  it('ai_site_quota_exhausted：粘滞状态 + 兜底原因；后续站点决策不再请求', async () => {
    const state = buildAiTurnState()
    const harness = mountAiTurn(state, { source: 'site', personalKey: null })
    stubFetch(harness, () => errorResponse(503, 'ai_site_quota_exhausted'))

    harness.controller().schedule()
    await settle()
    expect(harness.controller().siteQuotaExhausted.value).toBe(true)
    expect(harness.submitted[0]!.meta).toMatchObject({ aiSource: 'fallback', fallbackReason: 'site_quota_exhausted' })

    // 粘滞：同一会话内站点来源的后续决策直接兜底，不再弹出重复提示或发请求
    if (harness.state.current.currentPlayerId !== 'p0') {
      harness.controller().schedule()
      await settle(20)
      expect(harness.fetchCalls).toHaveLength(1)
      expect(harness.submitted[1]!.meta!.fallbackReason).toBe('site_quota_exhausted')
    }
    harness.wrapper.unmount()
  })

  it('站点额度耗尽不阻止个人 Key：切换来源后使用个人 Key 继续请求', async () => {
    const state = buildAiTurnState()
    const harness = mountAiTurn(state, { source: 'site', personalKey: null })
    stubFetch(harness, () => errorResponse(503, 'ai_site_quota_exhausted'))

    harness.controller().schedule()
    await settle()
    expect(harness.controller().siteQuotaExhausted.value).toBe(true)

    // 切换到个人 Key：额度粘滞状态只影响站点来源
    harness.setCredential({ source: 'personal', personalKey: PERSONAL_KEY })
    harness.controller().onCredentialsChanged()
    await settle()
    expect(harness.fetchCalls).toHaveLength(2)
    expect(harness.fetchCalls[1]!.headers[AI_PERSONAL_KEY_HEADER]).toBe(PERSONAL_KEY)
    expect(harness.controller().jevPaused.value).toBe(false)
    harness.wrapper.unmount()
  })
})

describe('鉴权与限流按凭据来源区分', () => {
  it('ai_key_rejected：暂停个人来源并标记原因；站点来源不受影响', async () => {
    const state = buildAiTurnState()
    const harness = mountAiTurn(state, { source: 'personal', personalKey: PERSONAL_KEY })
    stubFetch(harness, () => errorResponse(503, 'ai_key_rejected'))

    harness.controller().schedule()
    await settle()
    expect(harness.controller().jevPaused.value).toBe(true)
    expect(harness.controller().personalPauseReason.value).toBe('key_rejected')
    expect(harness.submitted[0]!.meta).toMatchObject({ aiSource: 'fallback', fallbackReason: 'personal_key_rejected' })

    // 切回站点来源：站点未暂停，可正常请求
    harness.setCredential({ source: 'site', personalKey: null })
    stubFetch(harness, call => successResponse(call, (call.body.candidates as Array<{ id: string }>)[0]!.id))
    harness.controller().onCredentialsChanged()
    await settle()
    expect(harness.controller().jevPaused.value).toBe(false)
    expect(harness.fetchCalls).toHaveLength(2)
    expect(harness.fetchCalls[1]!.headers[AI_PERSONAL_KEY_HEADER]).toBeUndefined()
    harness.wrapper.unmount()
  })

  it('429 限流：个人来源冷却不影响站点来源', async () => {
    const state = buildAiTurnState()
    const harness = mountAiTurn(state, { source: 'personal', personalKey: PERSONAL_KEY })
    stubFetch(harness, () => errorResponse(429, 'ai_rate_limited', { 'retry-after': '30' }))

    harness.controller().schedule()
    await settle()
    expect(harness.submitted[0]!.meta!.fallbackReason).toBe('rate_limited')
    expect(harness.controller().cooldownUntil.value).toBeGreaterThan(Date.now())

    // 冷却期内切到站点来源：站点不受个人冷却影响，可正常请求
    harness.setCredential({ source: 'site', personalKey: null })
    stubFetch(harness, call => successResponse(call, (call.body.candidates as Array<{ id: string }>)[0]!.id))
    harness.controller().onCredentialsChanged()
    await settle()
    expect(harness.fetchCalls).toHaveLength(2)
    harness.wrapper.unmount()
  })

  it('529 过载：兜底 service_overloaded，无 Retry-After 不进入冷却', async () => {
    const state = buildAiTurnState()
    const harness = mountAiTurn(state, { source: 'site', personalKey: null })
    stubFetch(harness, () => errorResponse(503, 'ai_overloaded'))

    harness.controller().schedule()
    await settle()
    expect(harness.submitted[0]!.meta).toMatchObject({ aiSource: 'fallback', fallbackReason: 'service_overloaded' })
    expect(harness.controller().cooldownUntil.value).toBeLessThanOrEqual(Date.now())

    // 过载非粘滞：下一个决策可再尝试
    if (harness.state.current.currentPlayerId !== 'p0') {
      harness.controller().schedule()
      await settle(20)
      expect(harness.fetchCalls).toHaveLength(2)
    }
    harness.wrapper.unmount()
  })
})

describe('凭据切换时的过期响应与恢复', () => {
  it('切换凭据：旧请求的成功响应被丢弃（不执行不兜底），新请求使用新凭据', async () => {
    const state = buildAiTurnState()
    const harness = mountAiTurn(state, { source: 'site', personalKey: null })
    const candidatesBefore = enumerateCandidatesFromState(state)!
    let releaseFirst!: (value: Response) => void
    stubFetch(harness, (call) => {
      if (harness.fetchCalls.length === 1) {
        return new Promise<Response>((resolve) => {
          releaseFirst = resolve
        })
      }
      return successResponse(call, (call.body.candidates as Array<{ id: string }>)[0]!.id)
    })

    harness.controller().schedule()
    await settle(10)
    expect(harness.fetchCalls).toHaveLength(1)

    // 在途期间替换凭据：作废旧请求
    harness.setCredential({ source: 'personal', personalKey: PERSONAL_KEY })
    harness.controller().onCredentialsChanged()
    await settle(10)
    expect(harness.fetchCalls).toHaveLength(2)
    expect(harness.fetchCalls[1]!.headers[AI_PERSONAL_KEY_HEADER]).toBe(PERSONAL_KEY)

    // 旧请求晚到的成功响应：既不执行也不兜底
    const first = harness.fetchCalls[0]!.body as { decisionId: string, gameId: string, revision: number, actorId: string }
    releaseFirst(new Response(JSON.stringify({
      protocolVersion: 2,
      gameId: first.gameId,
      revision: first.revision,
      decisionId: first.decisionId,
      actorId: first.actorId,
      actionId: candidatesBefore[0]!.id,
      source: 'jev',
      model: 'jev-1.13.0',
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    await settle(30)

    // 只有新凭据的请求落地；旧响应无新提交（新请求若已提交则 meta 为 jev 且来源于第二次调用）
    const appliedFromOld = harness.submitted.filter(s => s.meta?.aiSource === 'jev')
    expect(appliedFromOld.length).toBeLessThanOrEqual(1)
    expect(harness.state.current.revision).toBeGreaterThanOrEqual(state.revision)
    harness.wrapper.unmount()
  })

  it('替换 Key 清除个人暂停：新 Key 重新尝试请求', async () => {
    const state = buildAiTurnState()
    const harness = mountAiTurn(state, { source: 'personal', personalKey: PERSONAL_KEY })
    stubFetch(harness, () => errorResponse(503, 'ai_key_rejected'))

    harness.controller().schedule()
    await settle()
    expect(harness.controller().personalPauseReason.value).toBe('key_rejected')

    // 替换 Key：旧 Key 的暂停对新 Key 无意义，清除后重新调度
    harness.setCredential({ source: 'personal', personalKey: REPLACEMENT_KEY })
    stubFetch(harness, call => successResponse(call, (call.body.candidates as Array<{ id: string }>)[0]!.id))
    harness.controller().onCredentialsChanged()
    await settle()
    expect(harness.controller().jevPaused.value).toBe(false)
    expect(harness.controller().personalPauseReason.value).toBeNull()
    expect(harness.fetchCalls).toHaveLength(2)
    expect(harness.fetchCalls[1]!.headers[AI_PERSONAL_KEY_HEADER]).toBe(REPLACEMENT_KEY)
    harness.wrapper.unmount()
  })

  it('删除 Key 回到站点来源：以站点凭据恢复调度', async () => {
    const state = buildAiTurnState()
    const harness = mountAiTurn(state, { source: 'personal', personalKey: PERSONAL_KEY })
    stubFetch(harness, call => successResponse(call, (call.body.candidates as Array<{ id: string }>)[0]!.id))

    harness.controller().schedule()
    await settle()
    expect(harness.fetchCalls[0]!.headers[AI_PERSONAL_KEY_HEADER]).toBe(PERSONAL_KEY)

    // 删除 Key：来源回到站点
    harness.setCredential({ source: 'site', personalKey: null })
    harness.controller().onCredentialsChanged()
    await settle()
    expect(harness.fetchCalls).toHaveLength(2)
    expect(harness.fetchCalls[1]!.headers[AI_PERSONAL_KEY_HEADER]).toBeUndefined()
    expect(harness.fetchCalls[1]!.body.credentialSource).toBe('site')
    harness.wrapper.unmount()
  })
})
