import type { AiDecisionRequest } from '#shared/ai/protocol'
import type { GameState } from '#shared/game'
import type { AiDecisionLogEntry } from '../../server/utils/aiDecision'
/**
 * /api/ai/decision 核心逻辑测试：覆盖 A2（请求校验与候选约束）、
 * A3（mock 上游成功与各类失败）、A5（密钥只出现在服务端上游调用）。
 * 全部使用 mock fetch，不依赖 API key 或消耗额度。
 */
import { describe, expect, it } from 'vitest'
import {
  applyAction,
  createGame,
  enumerateCandidatesFromState,
  listLegalActions,
  projectForAi,
} from '#shared/game'
import { buildUpstreamPayload, handleAiDecision } from '../../server/utils/aiDecision'

const HOST = 'unojev.test'
const ORIGIN = `https://${HOST}`
const KEY_MARKER = 'ts_secret_key_marker_0123456789abcdef'
const PERSONAL_KEY_MARKER = 'ts_personal_key_marker_0123456789abcdef'
const MODEL = 'jev-1.13.0'
const RUNTIME = { typesafeApiKey: KEY_MARKER, typesafeModel: MODEL, siteQuotaExhausted: false }

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

/** 推进随机对局直到指定 AI 处于可决策状态且候选 ≥ 2。 */
function buildGameAt(actor: 'p1' | 'p2' | 'p3', seed = 1): GameState {
  for (let attempt = seed; attempt < seed + 200; attempt++) {
    const random = mulberry32(attempt)
    let state = createGame({ random, gameId: '12345678-1234-5678-1234-567812345678' })
    for (let step = 0; step < 200; step++) {
      if (state.phase.kind === 'finished') {
        break
      }
      if (state.currentPlayerId === actor) {
        const candidates = enumerateCandidatesFromState(state)
        if (candidates && candidates.length >= 2) {
          return state
        }
      }
      const actions = listLegalActions(state, state.currentPlayerId)
      const action = actions[Math.floor(random() * actions.length)]!
      const result = applyAction(state, {
        actorId: state.currentPlayerId,
        gameId: state.gameId,
        expectedRevision: state.revision,
        action,
      })
      if (!result.ok) {
        throw new Error(`推进失败: ${result.message}`)
      }
      state = result.state
    }
  }
  throw new Error('无法构造目标状态')
}

function buildRequest(state: GameState, actor: 'p1' | 'p2' | 'p3', decisionId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', credentialSource: 'site' | 'personal' = 'site'): AiDecisionRequest {
  return {
    protocolVersion: 2,
    rulesVersion: 'classic-single-v1',
    credentialSource,
    gameId: state.gameId,
    revision: state.revision,
    decisionId,
    actorId: actor,
    view: projectForAi(state, actor),
    candidates: enumerateCandidatesFromState(state)!,
  }
}

interface FetchCall { url: string, init: RequestInit }

function mockFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: FetchCall[] = []
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    const text = typeof body === 'string' ? body : JSON.stringify(body)
    return new Response(text, { status, headers: { 'content-type': 'application/json', ...headers } })
  }) as typeof fetch
  return { impl, calls }
}

function hangingFetch() {
  const calls: FetchCall[] = []
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    })
  }) as typeof fetch
  return { impl, calls }
}

function evenProbabilities(ids: string[]): Record<string, number> {
  const p = 1 / ids.length
  return Object.fromEntries(ids.map(id => [id, p]))
}

function successBody(candidates: Array<{ id: string }>, model = MODEL) {
  const ids = candidates.map(c => c.id)
  return {
    model,
    answers: {
      choose_action: {
        type: 'choice',
        choice: ids[0],
        confidence: 0.75,
        probabilities: evenProbabilities(ids),
      },
    },
    usage: { input_tokens: 321, output_tokens: 45 },
  }
}

function baseParams(request: AiDecisionRequest, overrides: Partial<Parameters<typeof handleAiDecision>[0]> = {}) {
  return {
    origin: ORIGIN,
    host: HOST,
    contentType: 'application/json',
    contentLength: null,
    bodyText: JSON.stringify(request),
    personalKey: null,
    runtimeConfig: RUNTIME,
    ...overrides,
  }
}

function logs(): { entries: AiDecisionLogEntry[], fn: (e: AiDecisionLogEntry) => void } {
  const entries: AiDecisionLogEntry[] = []
  return { entries, fn: e => entries.push(e) }
}

describe('成功路径与上游适配', () => {
  it('mock 成功：回映关联字段，actionId 命中候选，来源为 jev', async () => {
    const state = buildGameAt('p1')
    const request = buildRequest(state, 'p1')
    const { impl, calls } = mockFetch(200, successBody(request.candidates))
    const { entries, fn } = logs()
    const result = await handleAiDecision(baseParams(request, { fetchImpl: impl, log: fn }))

    expect(result.status).toBe(200)
    expect(result.headers['Cache-Control']).toBe('no-store')
    if ('error' in result.body) {
      throw new Error('不应失败')
    }
    expect(result.body).toEqual({
      protocolVersion: 2,
      gameId: request.gameId,
      revision: request.revision,
      decisionId: request.decisionId,
      actorId: 'p1',
      actionId: request.candidates[0]!.id,
      source: 'jev',
      model: MODEL,
    })
    // 恰好一次上游请求
    expect(calls.length).toBe(1)
    expect(calls[0]!.url).toBe('https://api.typesafe.ai/v1/systemone')

    // 上游 payload 结构：state 为投影视角，criteria 覆盖全部候选
    const payload = JSON.parse(String(calls[0]!.init.body))
    expect(Object.keys(payload)).toEqual(['model', 'state', 'questions'])
    expect(payload.model).toBe(MODEL)
    expect(payload.state).toEqual(request.view)
    expect(payload.questions.choose_action.type).toBe('choice')
    expect(payload.questions.choose_action.instructions).toContain('choose exactly one candidate action')
    expect(Object.keys(payload.questions.choose_action.criteria).sort()).toEqual(request.candidates.map(c => c.id).sort())
    for (const description of Object.values<string>(payload.questions.choose_action.criteria)) {
      expect(typeof description).toBe('string')
      expect(description.length).toBeGreaterThan(5)
    }

    // 日志仅含诊断字段
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ level: 'info', status: 200, decisionId: request.decisionId, model: MODEL, inputTokens: 321, outputTokens: 45 })
    expect(JSON.stringify(entries)).not.toContain(KEY_MARKER)
  })

  it('a5：假密钥标记仅出现在上游 Authorization 头，不进入响应、日志或上游 body', async () => {
    const state = buildGameAt('p2')
    const request = buildRequest(state, 'p2')
    const { impl, calls } = mockFetch(200, successBody(request.candidates))
    const { entries, fn } = logs()
    const result = await handleAiDecision(baseParams(request, { fetchImpl: impl, log: fn }))

    expect(result.status).toBe(200)
    expect(JSON.stringify(result)).not.toContain(KEY_MARKER)
    expect(JSON.stringify(entries)).not.toContain(KEY_MARKER)
    expect(JSON.stringify(calls[0]!.init.body)).not.toContain(KEY_MARKER)
    const auth = new Headers(calls[0]!.init.headers as HeadersInit).get('authorization')
    expect(auth).toBe(`Bearer ${KEY_MARKER}`)
  })

  it('after-draw 阶段：drawnCardId 在视角中且候选与枚举一致', async () => {
    // 找到 AI 的 after-draw 状态
    let state: GameState | null = null
    for (let seed = 1; seed < 300 && !state; seed++) {
      let s = createGame({ random: mulberry32(seed), gameId: '12345678-1234-5678-1234-567812345678' })
      for (let step = 0; step < 300; step++) {
        if (s.phase.kind === 'finished') {
          break
        }
        if (s.currentPlayerId !== 'p0' && s.phase.kind === 'after-draw') {
          state = s
          break
        }
        const actions = listLegalActions(s, s.currentPlayerId)
        const random = mulberry32(seed * 1000 + step)
        const action = actions[Math.floor(random() * actions.length)]!
        const result = applyAction(s, { actorId: s.currentPlayerId, gameId: s.gameId, expectedRevision: s.revision, action })
        if (!result.ok) {
          break
        }
        s = result.state
      }
    }
    expect(state).not.toBeNull()
    const actor = state!.currentPlayerId as 'p1' | 'p2' | 'p3'
    const request = buildRequest(state!, actor)
    expect(request.view.drawnCardId).toBeDefined()
    const { impl } = mockFetch(200, successBody(request.candidates))
    const result = await handleAiDecision(baseParams(request, { fetchImpl: impl }))
    expect(result.status).toBe(200)
  })
})

describe('请求校验（A2）', () => {
  it('外站 Origin 或缺失 Origin → 403 forbidden_origin 且不调用上游', async () => {
    const state = buildGameAt('p1')
    const request = buildRequest(state, 'p1')
    const { impl, calls } = mockFetch(200, successBody(request.candidates))

    for (const origin of [null, 'null', 'https://evil.example', 'http://other.test:1234']) {
      const result = await handleAiDecision(baseParams(request, { origin, fetchImpl: impl }))
      expect(result.status).toBe(403)
      expect(result.body).toEqual({ error: { code: 'forbidden_origin' } })
    }
    expect(calls).toHaveLength(0)
  })

  it('非 JSON Content-Type → 400', async () => {
    const state = buildGameAt('p1')
    const request = buildRequest(state, 'p1')
    const { impl, calls } = mockFetch(200, {})
    const result = await handleAiDecision(baseParams(request, { contentType: 'text/plain', fetchImpl: impl }))
    expect(result.status).toBe(400)
    expect(result.body).toEqual({ error: { code: 'invalid_request' } })
    expect(calls).toHaveLength(0)
  })

  it('请求体超过 64 KiB → 400（Content-Length 与实际体积两条路径）', async () => {
    const state = buildGameAt('p1')
    const request = buildRequest(state, 'p1')
    const { impl, calls } = mockFetch(200, {})

    const byHeader = await handleAiDecision(baseParams(request, {
      contentLength: String(64 * 1024 + 1),
      bodyText: '{}',
      fetchImpl: impl,
    }))
    expect(byHeader.status).toBe(400)

    const bigBody = JSON.stringify(request).padEnd(64 * 1024 + 10, ' ')
    const byBody = await handleAiDecision(baseParams(request, {
      contentLength: null,
      bodyText: bigBody,
      fetchImpl: impl,
    }))
    expect(byBody.status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it('坏 JSON、未知字段、错误版本、坏 UUID、负 revision、真人 actorId → 400', async () => {
    const state = buildGameAt('p1')
    const request = buildRequest(state, 'p1')
    const { impl, calls } = mockFetch(200, {})
    const cases: Array<[string, Partial<Parameters<typeof handleAiDecision>[0]>]> = [
      ['坏 JSON', { bodyText: '{oops' }],
      ['未知顶层字段', { bodyText: JSON.stringify({ ...request, evil: 'x' }) }],
      ['缺少 credentialSource 字段', { bodyText: JSON.stringify((({ credentialSource: _ignored, ...rest }) => rest)(request)) }],
      ['credentialSource 非法值', { bodyText: JSON.stringify({ ...request, credentialSource: 'admin' }) }],
      ['协议版本', { bodyText: JSON.stringify({ ...request, protocolVersion: 3 }) }],
      ['规则版本', { bodyText: JSON.stringify({ ...request, rulesVersion: 'other-v1' }) }],
      ['gameId 非 UUID', { bodyText: JSON.stringify({ ...request, gameId: 'nope' }) }],
      ['decisionId 非 UUID', { bodyText: JSON.stringify({ ...request, decisionId: 'nope' }) }],
      ['负 revision', { bodyText: JSON.stringify({ ...request, revision: -1 }) }],
      ['revision 小数', { bodyText: JSON.stringify({ ...request, revision: 1.5 }) }],
      ['actorId 为真人 p0', { bodyText: JSON.stringify({ ...request, actorId: 'p0', view: { ...request.view, actorId: 'p0', currentPlayerId: 'p0' } }) }],
      ['view 含未知字段', { bodyText: JSON.stringify({ ...request, view: { ...request.view, hiddenHint: 'x' } }) }],
      ['view 携带完整存档字段 drawPile', { bodyText: JSON.stringify({ ...request, view: { ...request.view, drawPile: ['red-1-1'] } }) }],
    ]
    for (const [name, overrides] of cases) {
      const result = await handleAiDecision(baseParams(request, { fetchImpl: impl, ...overrides }))
      expect(result.status, name).toBe(400)
      // decisionId 在被解析之后失败才会回显；此前失败不回显
      const body = JSON.parse(JSON.stringify(result.body)) as { error: { code: string }, decisionId?: string }
      expect(body.error.code, name).toBe('invalid_request')
      expect(body.decisionId === undefined || body.decisionId === request.decisionId, name).toBe(true)
    }
    expect(calls).toHaveLength(0)
  })

  it('视角自洽性：牌目录、互斥、总数、阶段与座位约束 → 400', async () => {
    const state = buildGameAt('p1')
    const request = buildRequest(state, 'p1')
    const { impl, calls } = mockFetch(200, {})
    const tampered = (mutate: (r: AiDecisionRequest) => AiDecisionRequest) => JSON.stringify(mutate(structuredClone(request)))

    const cases: Array<[string, string]> = [
      ['未知牌 ID', tampered((r) => {
        r.view.ownHand[0] = { ...r.view.ownHand[0]!, id: 'red-99-1' }
        return r
      })],
      ['牌面与目录不符', tampered((r) => {
        r.view.ownHand[0] = { ...r.view.ownHand[0]!, color: 'blue' }
        return r
      })],
      ['手牌与弃牌堆重叠', tampered((r) => {
        r.view.discardPile = [...r.view.discardPile, r.view.ownHand[0]!]
        return r
      })],
      ['牌总数不等于 108', tampered((r) => {
        r.view.drawPileCount = r.view.drawPileCount - 1
        return r
      })],
      ['currentPlayerId 与 actorId 不一致', tampered((r) => {
        r.view.currentPlayerId = 'p2'
        return r
      })],
      ['座位顺序错误', tampered((r) => {
        r.view.players = [...r.view.players].reverse()
        return r
      })],
      ['unoDeclared 与手牌数不符', tampered((r) => {
        r.view.players[1] = { ...r.view.players[1]!, handCount: 3, unoDeclared: true }
        return r
      })],
      ['handCount 与 ownHand 数量不符', tampered((r) => {
        r.view.players[1] = { ...r.view.players[1]!, handCount: r.view.ownHand.length + 1 }
        return r
      })],
      ['turn 阶段 currentColor 为 null', tampered((r) => {
        r.view.currentColor = null
        return r
      })],
      ['after-draw 缺 drawnCardId', tampered((r) => {
        r.view.phase = 'after-draw'
        return { ...r, view: { ...r.view, drawnCardId: undefined as unknown as string } }
      })],
      ['recentEvents 超过 12 条', tampered((r) => {
        r.view.recentEvents = Array.from({ length: 13 }).fill(r.view.recentEvents[0])
        return r
      })],
      ['事件含未知字段', tampered((r) => {
        r.view.recentEvents = [...r.view.recentEvents, { ...r.view.recentEvents[0]!, evil: 'x' }]
        return r
      })],
      ['事件 revision 为负', tampered((r) => {
        r.view.recentEvents = [{ ...r.view.recentEvents[0]!, revision: -1 }]
        return r
      })],
    ]
    for (const [name, bodyText] of cases) {
      const result = await handleAiDecision(baseParams(request, { fetchImpl: impl, bodyText }))
      expect(result.status, name).toBe(400)
      expect(result.body, name).toEqual({ error: { code: 'invalid_request' }, decisionId: request.decisionId })
    }
    expect(calls).toHaveLength(0)
  })

  it('候选约束：数量、伪造 ID、篡改动作语义、重复 ID、候选 ID 字符集', async () => {
    const state = buildGameAt('p1')
    const request = buildRequest(state, 'p1')
    const { impl, calls } = mockFetch(200, {})
    const tampered = (mutate: (r: AiDecisionRequest) => AiDecisionRequest) => JSON.stringify(mutate(structuredClone(request)))

    const cases: Array<[string, string]> = [
      ['单候选（< 2）', tampered((r) => {
        r.candidates = r.candidates.slice(0, 1)
        return r
      })],
      ['伪造候选 ID', tampered((r) => {
        r.candidates = [...r.candidates]
        r.candidates[0] = { id: 'play_red_1_1_none_no_uno_forged', action: r.candidates[0]!.action }
        return r
      })],
      ['篡改动作语义（declareUno）', tampered((r) => {
        r.candidates = [...r.candidates]
        const target = r.candidates.find(c => c.action.type === 'play')!
        target.action = { ...target.action, declareUno: !target.action.declareUno }
        return r
      })],
      ['篡改动作语义（chosenColor）', tampered((r) => {
        r.candidates = [...r.candidates]
        const target = r.candidates.find(c => c.action.type === 'play' && 'chosenColor' in c.action)
        if (target) {
          target.action = { ...target.action, chosenColor: target.action.chosenColor === 'red' ? 'blue' : 'red' }
        }
        else {
          // 无 Wild 候选时改为篡改 play 的 cardId（动作与 ID 不再对应）
          const play = r.candidates.find(c => c.action.type === 'play')!
          const other = r.view.ownHand.find(card => card.id !== play.action.cardId)!
          play.action = { ...play.action, cardId: other.id }
        }
        return r
      })],
      ['重复候选 ID', tampered((r) => {
        r.candidates = [...r.candidates]
        r.candidates[r.candidates.length - 1] = { ...r.candidates[r.candidates.length - 1]!, id: r.candidates[0]!.id }
        return r
      })],
      ['候选 ID 非法字符', tampered((r) => {
        r.candidates = [...r.candidates]
        r.candidates[0] = { id: 'Play-Red!', action: r.candidates[0]!.action }
        return r
      })],
      ['候选取自其他阶段（draw_one 换成 keep_drawn）', tampered((r) => {
        const drawOne = r.candidates.find(c => c.id === 'draw_one')!
        drawOne.id = 'keep_drawn'
        drawOne.action = { type: 'keep-drawn' }
        return r
      })],
      ['候选携带未知动作字段', tampered((r) => {
        r.candidates = [...r.candidates]
        r.candidates[0] = { id: r.candidates[0]!.id, action: { ...r.candidates[0]!.action, hint: 'play me' } }
        return r
      })],
    ]
    for (const [name, bodyText] of cases) {
      const result = await handleAiDecision(baseParams(request, { fetchImpl: impl, bodyText }))
      expect(result.status, name).toBe(400)
      expect(result.body, name).toEqual({ error: { code: 'invalid_request' }, decisionId: request.decisionId })
    }
    expect(calls).toHaveLength(0)
  })
})

describe('上游错误映射（A3：限流 / 过载 / 鉴权按凭据归属区分）', () => {
  const cases: Array<[string, number, unknown, number, string, Record<string, string>?]> = [
    ['上游 429 → 调用方限流', 429, {}, 429, 'ai_rate_limited', { 'retry-after': '60' }],
    ['上游 529 → 服务方过载（区别于限流）', 529, {}, 503, 'ai_overloaded', { 'retry-after': '15' }],
    ['上游 529 无 Retry-After → 仅错误码', 529, {}, 503, 'ai_overloaded', undefined],
    ['上游 401（站点密钥）→ ai_unavailable', 401, {}, 503, 'ai_unavailable', undefined],
    ['上游 403（站点密钥）→ ai_unavailable', 403, {}, 503, 'ai_unavailable', undefined],
    ['上游 422', 422, {}, 502, 'ai_upstream_error', undefined],
    ['上游 500', 500, {}, 502, 'ai_upstream_error', undefined],
    ['非 JSON 响应', 200, 'not json at all', 502, 'ai_invalid_response', undefined],
  ]
  for (const [name, upstreamStatus, upstreamBody, expectStatus, expectCode, headers] of cases) {
    it(`${name} → ${expectStatus} ${expectCode}`, async () => {
      const state = buildGameAt('p1')
      const request = buildRequest(state, 'p1')
      const { impl } = mockFetch(upstreamStatus, upstreamBody, headers)
      const result = await handleAiDecision(baseParams(request, { fetchImpl: impl }))
      expect(result.status).toBe(expectStatus)
      expect(result.body).toEqual({ error: { code: expectCode }, decisionId: request.decisionId })
      if (headers?.['retry-after']) {
        expect(result.headers['Retry-After']).toBe(headers['retry-after'])
      }
      else {
        expect(result.headers['Retry-After']).toBeUndefined()
      }
    })
  }

  it('个人 Key 请求：上游 401/403 → ai_key_rejected（归属用户自己的 Key）', async () => {
    for (const status of [401, 403]) {
      const state = buildGameAt('p1')
      const request = buildRequest(state, 'p1', undefined, 'personal')
      const { impl } = mockFetch(status, {})
      const result = await handleAiDecision(baseParams(request, { personalKey: PERSONAL_KEY_MARKER, fetchImpl: impl }))
      expect(result.status, `上游 ${status}`).toBe(503)
      expect(result.body, `上游 ${status}`).toEqual({ error: { code: 'ai_key_rejected' }, decisionId: request.decisionId })
    }
  })

  it('上游响应结构缺失或非法 → 502 ai_invalid_response', async () => {
    const state = buildGameAt('p1')
    const request = buildRequest(state, 'p1')
    const candidateIds = request.candidates.map(c => c.id)

    const badBodies: Array<[string, unknown]> = [
      ['缺 model', { answers: { choose_action: { type: 'choice', choice: candidateIds[0], confidence: 1, probabilities: evenProbabilities(candidateIds) } } }],
      ['model 非字符串', { model: 42, answers: { choose_action: { type: 'choice', choice: candidateIds[0], confidence: 1, probabilities: evenProbabilities(candidateIds) } } }],
      ['缺 answers', { model: MODEL }],
      ['缺 choose_action', { model: MODEL, answers: {} }],
      ['type 非 choice', { model: MODEL, answers: { choose_action: { type: 'score', choice: candidateIds[0], confidence: 1, probabilities: evenProbabilities(candidateIds) } } }],
      ['choice 不在候选中', { model: MODEL, answers: { choose_action: { type: 'choice', choice: 'not_a_candidate', confidence: 1, probabilities: evenProbabilities(candidateIds) } } }],
      ['缺 probabilities', { model: MODEL, answers: { choose_action: { type: 'choice', choice: candidateIds[0], confidence: 1 } } }],
      ['概率键不完整', { model: MODEL, answers: { choose_action: { type: 'choice', choice: candidateIds[0], confidence: 1, probabilities: { [candidateIds[0]!]: 1 } } } }],
      ['概率和不为 1', { model: MODEL, answers: { choose_action: { type: 'choice', choice: candidateIds[0], confidence: 1, probabilities: Object.fromEntries(candidateIds.map(id => [id, 0.1])) } } }],
      ['概率超出 0..1', { model: MODEL, answers: { choose_action: { type: 'choice', choice: candidateIds[0], confidence: 1, probabilities: Object.fromEntries(candidateIds.map((id, i) => [id, i === 0 ? 1.5 : 0])) } } }],
      ['概率非有限数值', { model: MODEL, answers: { choose_action: { type: 'choice', choice: candidateIds[0], confidence: 1, probabilities: Object.fromEntries(candidateIds.map((id, i) => [id, i === 0 ? Number.NaN : 1])) } } }],
      ['缺 confidence', { model: MODEL, answers: { choose_action: { type: 'choice', choice: candidateIds[0], probabilities: evenProbabilities(candidateIds) } } }],
      ['confidence 超界', { model: MODEL, answers: { choose_action: { type: 'choice', choice: candidateIds[0], confidence: 1.2, probabilities: evenProbabilities(candidateIds) } } }],
    ]
    for (const [name, body] of badBodies) {
      const { impl } = mockFetch(200, body)
      const result = await handleAiDecision(baseParams(request, { fetchImpl: impl }))
      expect(result.status, name).toBe(502)
      expect(result.body, name).toEqual({ error: { code: 'ai_invalid_response' }, decisionId: request.decisionId })
    }
  })

  it('worker 超时 → 504 ai_timeout', async () => {
    const state = buildGameAt('p1')
    const request = buildRequest(state, 'p1')
    const { impl, calls } = hangingFetch()
    const result = await handleAiDecision(baseParams(request, { fetchImpl: impl, upstreamTimeoutMs: 30 }))
    expect(result.status).toBe(504)
    expect(result.body).toEqual({ error: { code: 'ai_timeout' }, decisionId: request.decisionId })
    expect(calls).toHaveLength(1)
  })

  it('fetch 网络错误 → 502 ai_upstream_error', async () => {
    const state = buildGameAt('p1')
    const request = buildRequest(state, 'p1')
    const impl = (async () => {
      throw new TypeError('fetch failed')
    }) as typeof fetch
    const result = await handleAiDecision(baseParams(request, { fetchImpl: impl }))
    expect(result.status).toBe(502)
    expect(result.body).toEqual({ error: { code: 'ai_upstream_error' }, decisionId: request.decisionId })
  })

  it('缺 API key 配置（站点来源）→ 503 ai_unavailable，不调用上游', async () => {
    const state = buildGameAt('p1')
    const request = buildRequest(state, 'p1')
    const { impl, calls } = mockFetch(200, {})
    const result = await handleAiDecision(baseParams(request, {
      fetchImpl: impl,
      runtimeConfig: { typesafeApiKey: '', typesafeModel: MODEL, siteQuotaExhausted: false },
    }))
    expect(result.status).toBe(503)
    expect(result.body).toEqual({ error: { code: 'ai_unavailable' }, decisionId: request.decisionId })
    expect(calls).toHaveLength(0)
  })

  it('缺模型配置（个人来源）→ 503 ai_unavailable（服务端配置问题，不归咎个人 Key）', async () => {
    const state = buildGameAt('p1')
    const request = buildRequest(state, 'p1', undefined, 'personal')
    const { impl, calls } = mockFetch(200, {})
    const result = await handleAiDecision(baseParams(request, {
      personalKey: PERSONAL_KEY_MARKER,
      fetchImpl: impl,
      runtimeConfig: { typesafeApiKey: '', typesafeModel: '', siteQuotaExhausted: false },
    }))
    expect(result.status).toBe(503)
    expect(result.body).toEqual({ error: { code: 'ai_unavailable' }, decisionId: request.decisionId })
    expect(calls).toHaveLength(0)
  })
})

describe('凭据来源选择与个人 Key 传递', () => {
  it('个人 Key 请求：上游 Authorization 使用个人 Key，站点密钥不被使用或泄露', async () => {
    const state = buildGameAt('p1')
    const request = buildRequest(state, 'p1', undefined, 'personal')
    const { impl, calls } = mockFetch(200, successBody(request.candidates))
    const { entries, fn } = logs()
    const result = await handleAiDecision(baseParams(request, { personalKey: PERSONAL_KEY_MARKER, fetchImpl: impl, log: fn }))

    expect(result.status).toBe(200)
    expect(calls).toHaveLength(1)
    const auth = new Headers(calls[0]!.init.headers as HeadersInit).get('authorization')
    expect(auth).toBe(`Bearer ${PERSONAL_KEY_MARKER}`)
    // 个人模式不消耗站点密钥：站点密钥不出现在上游调用与任何输出中
    expect(JSON.stringify(calls[0]!.init.body)).not.toContain(KEY_MARKER)
    expect(JSON.stringify(result)).not.toContain(KEY_MARKER)
    expect(JSON.stringify(entries)).not.toContain(KEY_MARKER)
    // 个人 Key 本身不进入请求体、响应或日志（只经专用请求头 → 上游 Authorization）
    expect(JSON.stringify(calls[0]!.init.body)).not.toContain(PERSONAL_KEY_MARKER)
    expect(JSON.stringify(result)).not.toContain(PERSONAL_KEY_MARKER)
    expect(JSON.stringify(entries)).not.toContain(PERSONAL_KEY_MARKER)
    // 日志记录凭据来源（诊断字段，不含密钥值）
    expect(entries[0]).toMatchObject({ credentialSource: 'personal', status: 200 })
  })

  it('个人 Key 请求：Key 只经请求头传递，不进入本站请求体与上游 payload', async () => {
    const state = buildGameAt('p1')
    const request = buildRequest(state, 'p1', undefined, 'personal')
    const { impl, calls } = mockFetch(200, successBody(request.candidates))
    const params = baseParams(request, { personalKey: PERSONAL_KEY_MARKER, fetchImpl: impl })
    // 本站请求体声明来源，但不含 Key 值
    const requestJson = JSON.parse(params.bodyText) as Record<string, unknown>
    expect(requestJson.credentialSource).toBe('personal')
    expect(params.bodyText).not.toContain(PERSONAL_KEY_MARKER)
    await handleAiDecision(params)
    // 上游 payload 同样不含 Key 值
    expect(JSON.stringify(calls[0]!.init.body)).not.toContain(PERSONAL_KEY_MARKER)
  })

  it('personal 声明但缺少请求头 / 格式非法 → 400，不调用上游，不回退站点密钥', async () => {
    const state = buildGameAt('p1')
    const request = buildRequest(state, 'p1', undefined, 'personal')
    const { impl, calls } = mockFetch(200, {})
    const cases: Array<[string, string | null]> = [
      ['缺少请求头', null],
      ['空字符串', ''],
      ['超长', 'a'.repeat(257)],
      ['含空格', 'bad key'],
      ['含控制字符', 'bad\nkey'],
    ]
    for (const [name, personalKey] of cases) {
      const result = await handleAiDecision(baseParams(request, { personalKey, fetchImpl: impl }))
      expect(result.status, name).toBe(400)
      expect(result.body, name).toEqual({ error: { code: 'invalid_request' }, decisionId: request.decisionId })
    }
    expect(calls).toHaveLength(0)
  })

  it('site 声明却携带个人 Key 头 → 400（来源矛盾，避免凭据歧义）', async () => {
    const state = buildGameAt('p1')
    const request = buildRequest(state, 'p1')
    const { impl, calls } = mockFetch(200, {})
    const result = await handleAiDecision(baseParams(request, { personalKey: PERSONAL_KEY_MARKER, fetchImpl: impl }))
    expect(result.status).toBe(400)
    expect(result.body).toEqual({ error: { code: 'invalid_request' }, decisionId: request.decisionId })
    expect(calls).toHaveLength(0)
  })

  it('站点额度耗尽开关：站点来源 → 503 ai_site_quota_exhausted，不调用上游', async () => {
    const state = buildGameAt('p1')
    const request = buildRequest(state, 'p1')
    const { impl, calls } = mockFetch(200, {})
    const { entries, fn } = logs()
    const result = await handleAiDecision(baseParams(request, {
      fetchImpl: impl,
      log: fn,
      runtimeConfig: { typesafeApiKey: KEY_MARKER, typesafeModel: MODEL, siteQuotaExhausted: true },
    }))
    expect(result.status).toBe(503)
    expect(result.body).toEqual({ error: { code: 'ai_site_quota_exhausted' }, decisionId: request.decisionId })
    expect(calls).toHaveLength(0)
    expect(entries[0]).toMatchObject({ code: 'ai_site_quota_exhausted', credentialSource: 'site' })
  })

  it('站点额度耗尽开关不影响个人 Key 请求：正常调用上游', async () => {
    const state = buildGameAt('p1')
    const request = buildRequest(state, 'p1', undefined, 'personal')
    const { impl, calls } = mockFetch(200, successBody(request.candidates))
    const result = await handleAiDecision(baseParams(request, {
      personalKey: PERSONAL_KEY_MARKER,
      fetchImpl: impl,
      runtimeConfig: { typesafeApiKey: '', typesafeModel: MODEL, siteQuotaExhausted: true },
    }))
    expect(result.status).toBe(200)
    expect(calls).toHaveLength(1)
  })

  it('上游 429 不被误判为额度耗尽：返回 ai_rate_limited（站点与个人一致）', async () => {
    for (const [source, personalKey] of [['site', null], ['personal', PERSONAL_KEY_MARKER]] as const) {
      const state = buildGameAt('p1')
      const request = buildRequest(state, 'p1', undefined, source)
      const { impl } = mockFetch(429, {}, { 'retry-after': '30' })
      const result = await handleAiDecision(baseParams(request, { personalKey, fetchImpl: impl }))
      expect(result.status, source).toBe(429)
      expect(result.body, source).toEqual({ error: { code: 'ai_rate_limited' }, decisionId: request.decisionId })
    }
  })
})

describe('buildUpstreamPayload', () => {
  it('a1：上游 payload 不含其他玩家手牌与抽牌堆内容', () => {
    // 构造一个 p1 决策状态，检查 p2/p3/p0 的手牌标记不出现在 state 中
    const state = buildGameAt('p1', 5)
    const view = projectForAi(state, 'p1')
    const candidates = enumerateCandidatesFromState(state)!
    const payload = buildUpstreamPayload(MODEL, view, candidates)

    const otherHands = state.players.filter(p => p.id !== 'p1').flatMap(p => p.hand)
    const serialized = JSON.stringify(payload)
    for (const marker of otherHands) {
      expect(serialized, `其他玩家手牌 ${marker} 不应出现在 payload`).not.toContain(`"${marker}"`)
    }
    for (const marker of state.drawPile) {
      expect(serialized, `抽牌堆 ${marker} 不应出现在 payload`).not.toContain(`"${marker}"`)
    }
  })
})

describe('超时覆盖响应正文读取（问题 7 回归）', () => {
  /** 假上游：响应头立即返回，正文在 delayMs 后到达；abort 时终止流。 */
  function slowBodyFetch(delayMs: number, body: string) {
    const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const encoder = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const timer = setTimeout(() => {
            controller.enqueue(encoder.encode(body))
            controller.close()
          }, delayMs)
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            controller.error(new DOMException('Aborted', 'AbortError'))
          })
        },
      })
      return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    return impl
  }

  it('响应头及时但正文超时：50ms 预算下正文延迟 300ms → 504 ai_timeout（旧版会返回 200）', async () => {
    const state = buildGameAt('p1')
    const request = buildRequest(state, 'p1')
    const body = JSON.stringify(successBody(request.candidates))
    const result = await handleAiDecision(baseParams(request, {
      fetchImpl: slowBodyFetch(300, body),
      upstreamTimeoutMs: 50,
    }))
    expect(result.status).toBe(504)
    expect(result.body).toEqual({ error: { code: 'ai_timeout' }, decisionId: request.decisionId })
  })

  it('正文在预算内到达：仍返回 200（超时保护不误伤正常响应）', async () => {
    const state = buildGameAt('p1')
    const request = buildRequest(state, 'p1')
    const body = JSON.stringify(successBody(request.candidates))
    const result = await handleAiDecision(baseParams(request, {
      fetchImpl: slowBodyFetch(20, body),
      upstreamTimeoutMs: 500,
    }))
    expect(result.status).toBe(200)
    if (!('error' in result.body)) {
      expect(result.body.actionId).toBe(request.candidates[0]!.id)
    }
  })

  it('正文读取中断（未超时）→ 502 ai_upstream_error，且不透传上游内容', async () => {
    const state = buildGameAt('p1')
    const request = buildRequest(state, 'p1')
    const impl = (async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new TypeError('socket hang up'))
        },
      })
      return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const result = await handleAiDecision(baseParams(request, { fetchImpl: impl, upstreamTimeoutMs: 500 }))
    expect(result.status).toBe(502)
    expect(result.body).toEqual({ error: { code: 'ai_upstream_error' }, decisionId: request.decisionId })
  })

  it('正文超时只发起一次上游请求（不重试）', async () => {
    const state = buildGameAt('p1')
    const request = buildRequest(state, 'p1')
    let calls = 0
    const base = slowBodyFetch(300, JSON.stringify(successBody(request.candidates)))
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls++
      return base(url, init)
    }) as typeof fetch
    const result = await handleAiDecision(baseParams(request, { fetchImpl: impl, upstreamTimeoutMs: 50 }))
    expect(result.status).toBe(504)
    expect(calls).toBe(1)
  })
})
