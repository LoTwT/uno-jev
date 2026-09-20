/**
 * /api/ai/decision 的核心处理逻辑：请求校验、TypeSafe 适配与错误映射。
 *
 * 本模块不依赖 h3 / Nuxt，fetch、超时与日志全部可注入，便于单元测试；
 * Worker 只代理受限的 Jev 决策请求：不保存对局、不安排下一回合，
 * 用户不能通过额外字段把端点变成通用 TypeSafe 代理（规格：AI 决策协议）。
 */
import type {
  AiDecisionRequest,
  AiDecisionResponse,
  AiDecisionResult,
  AiErrorCode,
} from '#shared/ai/protocol'
import type { AiView, AiViewPlayerInfo, Candidate, Card, Color, PlayerId, PublicEvent } from '#shared/game'
import {
  AI_CANDIDATE_ID_MAX_LENGTH,
  AI_CANDIDATE_ID_PATTERN,
  AI_MAX_CANDIDATES,
  AI_MIN_CANDIDATES,
  AI_PROTOCOL_VERSION,
  AI_REQUEST_BODY_LIMIT_BYTES,
  AI_RULES_VERSION,
} from '#shared/ai/protocol'
import { buildDecisionContextFromView, CHOOSE_ACTION_INSTRUCTIONS, describeCandidate, enumerateCandidates, getCard, isColor, isPlayerId } from '#shared/game'

export const TYPESAFE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'

/** Worker 每次上游调用默认 6 秒超时（产品等待预算，不是已测性能）。 */
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 6000

export interface AiDecisionLogEntry {
  level: 'info' | 'error'
  event: 'ai_decision'
  status: number
  code?: AiErrorCode
  /** 校验失败的字段级诊断（仅服务端日志，不进入响应体）。 */
  detail?: string
  durationMs: number
  /** 请求的模型名与上游实际响应的模型名。 */
  requestedModel?: string
  model?: string
  decisionId?: string
  inputTokens?: number
  outputTokens?: number
}

export type AiDecisionLogFn = (entry: AiDecisionLogEntry) => void

export interface AiDecisionHandlerParams {
  origin: string | null
  host: string | null
  contentType: string | null
  contentLength: string | null
  bodyText: string
  runtimeConfig: { typesafeApiKey: string, typesafeModel: string }
  fetchImpl?: typeof fetch
  upstreamTimeoutMs?: number
  log?: AiDecisionLogFn
}

export interface AiDecisionHandlerResult {
  status: number
  headers: Record<string, string>
  body: AiDecisionResult
}

class InvalidRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidRequestError'
  }
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 拒绝未知字段，防止端点被扩展为通用代理。 */
function requireExactKeys(obj: Record<string, unknown>, keys: readonly string[], where: string): void {
  const actual = Object.keys(obj)
  const expected = new Set(keys)
  for (const key of actual) {
    if (!expected.has(key)) {
      throw new InvalidRequestError(`${where} 含未知字段: ${key}`)
    }
  }
  for (const key of keys) {
    if (!(key in obj)) {
      throw new InvalidRequestError(`${where} 缺少字段: ${key}`)
    }
  }
}

function requireString(value: unknown, where: string, maxLength = 128): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new InvalidRequestError(`${where} 必须是 1..${maxLength} 字符的字符串`)
  }
  return value
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function requireUuid(value: unknown, where: string): string {
  const str = requireString(value, where, 36)
  if (!UUID_PATTERN.test(str)) {
    throw new InvalidRequestError(`${where} 必须是标准 36 字符 UUID`)
  }
  return str
}

function requireSafeInt(value: unknown, where: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new InvalidRequestError(`${where} 必须是 ${min}..${max} 的安全整数`)
  }
  return value
}

function requireEnum<T extends string>(value: unknown, where: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new InvalidRequestError(`${where} 必须是 ${allowed.join(' / ')} 之一`)
  }
  return value as T
}

/** 校验单张牌：字段精确、命中固定目录且牌面一致。 */
function requireCard(value: unknown, where: string): Card {
  if (!isPlainObject(value)) {
    throw new InvalidRequestError(`${where} 必须是对象`)
  }
  requireExactKeys(value, ['id', 'kind', 'color', 'value'], where)
  const id = requireString(value.id, `${where}.id`, 32)
  const card = getCard(id)
  if (!card) {
    throw new InvalidRequestError(`${where}.id 未命中固定牌组目录: ${id}`)
  }
  if (value.kind !== card.kind || value.color !== card.color || value.value !== card.value) {
    throw new InvalidRequestError(`${where} 牌面与目录不符: ${id}`)
  }
  return card
}

const PLAYER_TYPES = ['human', 'jev'] as const
const DRAW_REASONS = ['turn', 'draw-two', 'wild-draw-four', 'uno-miss', 'opening-draw-two'] as const
const SKIP_REASONS = ['skip', 'draw-two', 'wild-draw-four', 'opening-skip', 'opening-draw-two'] as const
const DECISION_SOURCES = ['jev', 'forced', 'fallback'] as const
const FALLBACK_REASONS = ['invalid_request', 'rate_limited', 'ai_unavailable', 'invalid_response', 'upstream_error', 'timeout', 'network_error', 'offline'] as const
const EVENT_TYPES = [
  'game-started',
  'opening-color-chosen',
  'card-played',
  'direction-reversed',
  'uno-declared',
  'uno-miss-caught',
  'cards-drawn',
  'player-skipped',
  'pile-reshuffled',
  'kept-drawn',
  'decision-source',
  'game-finished',
] as const
const PLAYER_IDS = ['p0', 'p1', 'p2', 'p3'] as const

function requirePlayerId(value: unknown, where: string): PlayerId {
  if (!isPlayerId(value)) {
    throw new InvalidRequestError(`${where} 必须是 p0..p3 之一`)
  }
  return value
}

function requireColor(value: unknown, where: string): Color {
  if (!isColor(value)) {
    throw new InvalidRequestError(`${where} 必须是 red/yellow/green/blue 之一`)
  }
  return value
}

/** 校验公开事件；事件结构是发给模型的 state 的一部分，必须锁死形状。 */
function requireEvent(value: unknown, where: string): void {
  if (!isPlainObject(value)) {
    throw new InvalidRequestError(`${where} 必须是对象`)
  }
  if (typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0) {
    throw new InvalidRequestError(`${where}.revision 必须是非负安全整数`)
  }
  const type = requireEnum(value.type, `${where}.type`, EVENT_TYPES)
  const id = (v: unknown, w: string) => requirePlayerId(v, w)
  switch (type) {
    case 'game-started':
      requireExactKeys(value, ['revision', 'type', 'dealerId', 'openingCardId'], where)
      id(value.dealerId, `${where}.dealerId`)
      requireString(value.openingCardId, `${where}.openingCardId`, 32)
      break
    case 'opening-color-chosen':
      requireExactKeys(value, ['revision', 'type', 'playerId', 'color'], where)
      id(value.playerId, `${where}.playerId`)
      requireColor(value.color, `${where}.color`)
      break
    case 'card-played': {
      const keys = 'chosenColor' in value ? ['revision', 'type', 'playerId', 'cardId', 'chosenColor'] : ['revision', 'type', 'playerId', 'cardId']
      requireExactKeys(value, keys, where)
      id(value.playerId, `${where}.playerId`)
      requireString(value.cardId, `${where}.cardId`, 32)
      if ('chosenColor' in value) {
        requireColor(value.chosenColor, `${where}.chosenColor`)
      }
      break
    }
    case 'direction-reversed':
      requireExactKeys(value, ['revision', 'type', 'byPlayerId'], where)
      id(value.byPlayerId, `${where}.byPlayerId`)
      break
    case 'uno-declared':
      requireExactKeys(value, ['revision', 'type', 'playerId'], where)
      id(value.playerId, `${where}.playerId`)
      break
    case 'uno-miss-caught':
      requireExactKeys(value, ['revision', 'type', 'playerId', 'caughtBy', 'penaltyCount'], where)
      id(value.playerId, `${where}.playerId`)
      id(value.caughtBy, `${where}.caughtBy`)
      requireSafeInt(value.penaltyCount, `${where}.penaltyCount`, 1, 10)
      break
    case 'cards-drawn':
      requireExactKeys(value, ['revision', 'type', 'playerId', 'requested', 'drawn', 'reason'], where)
      id(value.playerId, `${where}.playerId`)
      requireSafeInt(value.requested, `${where}.requested`, 0, 30)
      requireSafeInt(value.drawn, `${where}.drawn`, 0, 30)
      requireEnum(value.reason, `${where}.reason`, DRAW_REASONS)
      break
    case 'player-skipped':
      requireExactKeys(value, ['revision', 'type', 'playerId', 'reason'], where)
      id(value.playerId, `${where}.playerId`)
      requireEnum(value.reason, `${where}.reason`, SKIP_REASONS)
      break
    case 'pile-reshuffled':
      requireExactKeys(value, ['revision', 'type', 'recycledCount'], where)
      requireSafeInt(value.recycledCount, `${where}.recycledCount`, 0, 107)
      break
    case 'kept-drawn':
      requireExactKeys(value, ['revision', 'type', 'playerId'], where)
      id(value.playerId, `${where}.playerId`)
      break
    case 'decision-source': {
      const keys = 'reason' in value ? ['revision', 'type', 'playerId', 'source', 'reason'] : ['revision', 'type', 'playerId', 'source']
      requireExactKeys(value, keys, where)
      id(value.playerId, `${where}.playerId`)
      requireEnum(value.source, `${where}.source`, DECISION_SOURCES)
      if ('reason' in value) {
        requireEnum(value.reason, `${where}.reason`, FALLBACK_REASONS)
      }
      break
    }
    case 'game-finished': {
      requireExactKeys(value, ['revision', 'type', 'result'], where)
      if (!isPlainObject(value.result)) {
        throw new InvalidRequestError(`${where}.result 必须是对象`)
      }
      const reason = requireEnum(value.result.reason, `${where}.result.reason`, ['empty-hand', 'blocked'] as const)
      if (reason === 'empty-hand') {
        requireExactKeys(value.result, ['reason', 'winnerId'], `${where}.result`)
        requirePlayerId(value.result.winnerId, `${where}.result.winnerId`)
      }
      else {
        requireExactKeys(value.result, ['reason', 'winnerId'], `${where}.result`)
        if (value.result.winnerId !== null) {
          throw new InvalidRequestError(`${where}.result.winnerId 必须为 null`)
        }
      }
      break
    }
  }
}

function requireView(value: unknown): AiView {
  if (!isPlainObject(value)) {
    throw new InvalidRequestError('view 必须是对象')
  }
  const hasDrawn = 'drawnCardId' in value
  requireExactKeys(value, hasDrawn
    ? ['actorId', 'ownHand', 'phase', 'drawnCardId', 'currentColor', 'direction', 'currentPlayerId', 'dealerId', 'discardPile', 'drawPileCount', 'players', 'recentEvents']
    : ['actorId', 'ownHand', 'phase', 'currentColor', 'direction', 'currentPlayerId', 'dealerId', 'discardPile', 'drawPileCount', 'players', 'recentEvents'], 'view')

  const actorId = requirePlayerId(value.actorId, 'view.actorId')
  const phase = requireEnum(value.phase, 'view.phase', ['opening-color', 'turn', 'after-draw'] as const)

  const ownHand = value.ownHand
  if (!Array.isArray(ownHand) || ownHand.length === 0 || ownHand.length > 108) {
    throw new InvalidRequestError('view.ownHand 必须是 1..108 张牌的数组')
  }
  const ownHandCards = ownHand.map((card, i) => requireCard(card, `view.ownHand[${i}]`))
  const ownHandIds = new Set(ownHandCards.map(card => card.id))
  if (ownHandIds.size !== ownHandCards.length) {
    throw new InvalidRequestError('view.ownHand 牌 ID 必须互不重复')
  }

  let drawnCardId: string | undefined
  if (hasDrawn) {
    drawnCardId = requireString(value.drawnCardId, 'view.drawnCardId', 32)
    if (phase !== 'after-draw') {
      throw new InvalidRequestError('view.drawnCardId 只能在 after-draw 阶段出现')
    }
    if (!ownHandIds.has(drawnCardId)) {
      throw new InvalidRequestError('view.drawnCardId 必须在自己的手牌中')
    }
  }
  else if (phase === 'after-draw') {
    throw new InvalidRequestError('after-draw 阶段必须携带 view.drawnCardId')
  }

  const currentColor = value.currentColor
  if (phase === 'opening-color') {
    if (currentColor !== null) {
      throw new InvalidRequestError('opening-color 阶段 currentColor 必须为 null')
    }
  }
  else if (!isColor(currentColor)) {
    throw new InvalidRequestError('view.currentColor 必须是有效颜色')
  }

  if (value.direction !== 1 && value.direction !== -1) {
    throw new InvalidRequestError('view.direction 必须为 1 或 -1')
  }
  const dir: 1 | -1 = value.direction

  const currentPlayerId = requirePlayerId(value.currentPlayerId, 'view.currentPlayerId')
  if (currentPlayerId !== actorId) {
    throw new InvalidRequestError('view.currentPlayerId 必须等于 actorId（只为当前行动者请求决策）')
  }
  const dealerId = requirePlayerId(value.dealerId, 'view.dealerId')

  const discardPile = value.discardPile
  if (!Array.isArray(discardPile) || discardPile.length === 0 || discardPile.length > 108) {
    throw new InvalidRequestError('view.discardPile 必须是非空牌数组')
  }
  const discardCards = discardPile.map((card, i) => requireCard(card, `view.discardPile[${i}]`))
  const discardIds = new Set(discardCards.map(card => card.id))
  if (discardIds.size !== discardCards.length) {
    throw new InvalidRequestError('view.discardPile 牌 ID 必须互不重复')
  }
  for (const id of ownHandIds) {
    if (discardIds.has(id)) {
      throw new InvalidRequestError('view.ownHand 与 view.discardPile 的牌 ID 必须互斥')
    }
  }

  const drawPileCount = requireSafeInt(value.drawPileCount, 'view.drawPileCount', 0, 108)

  const playersRaw = value.players
  if (!Array.isArray(playersRaw) || playersRaw.length !== 4) {
    throw new InvalidRequestError('view.players 必须固定 4 个座位')
  }
  const players: AiViewPlayerInfo[] = playersRaw.map((player, i) => {
    if (!isPlainObject(player)) {
      throw new InvalidRequestError(`view.players[${i}] 必须是对象`)
    }
    requireExactKeys(player, ['id', 'name', 'type', 'handCount', 'unoDeclared'], `view.players[${i}]`)
    const id = requirePlayerId(player.id, `view.players[${i}].id`)
    if (id !== PLAYER_IDS[i]) {
      throw new InvalidRequestError(`view.players[${i}].id 必须为 ${PLAYER_IDS[i]}（座位顺序固定）`)
    }
    requireString(player.name, `view.players[${i}].name`, 32)
    requireEnum(player.type, `view.players[${i}].type`, PLAYER_TYPES)
    const handCount = requireSafeInt(player.handCount, `view.players[${i}].handCount`, 1, 108)
    if (typeof player.unoDeclared !== 'boolean') {
      throw new InvalidRequestError(`view.players[${i}].unoDeclared 必须是布尔值`)
    }
    if (player.unoDeclared && handCount !== 1) {
      throw new InvalidRequestError(`view.players[${i}].unoDeclared 仅在剩 1 张时可为 true`)
    }
    return { id, name: player.name as string, type: player.type as 'human' | 'jev', handCount, unoDeclared: player.unoDeclared as boolean }
  })

  const actorEntry = players.find(player => player.id === actorId)!
  if (actorEntry.handCount !== ownHandCards.length) {
    throw new InvalidRequestError('view.ownHand 数量必须与该座位 handCount 一致')
  }
  const totalCards = players.reduce((n, p) => n + p.handCount, 0) + discardCards.length + drawPileCount
  if (totalCards !== 108) {
    throw new InvalidRequestError(`可见牌数与 108 不符（${totalCards}）`)
  }

  const recentEvents = value.recentEvents
  if (!Array.isArray(recentEvents) || recentEvents.length > 12) {
    throw new InvalidRequestError('view.recentEvents 必须是不超过 12 条的数组')
  }
  recentEvents.forEach((eventValue, i) => requireEvent(eventValue, `view.recentEvents[${i}]`))

  const view: AiView = {
    actorId,
    ownHand: ownHandCards,
    phase,
    ...(drawnCardId !== undefined ? { drawnCardId } : {}),
    currentColor,
    direction: dir,
    currentPlayerId,
    dealerId,
    discardPile: discardCards,
    drawPileCount,
    players,
    recentEvents: recentEvents as unknown as PublicEvent[],
  }

  if (phase === 'opening-color') {
    const top = discardCards[discardCards.length - 1]!
    if (top.kind !== 'wild') {
      throw new InvalidRequestError('opening-color 阶段弃牌堆顶牌必须是 Wild')
    }
    if (dir !== 1) {
      throw new InvalidRequestError('opening-color 阶段方向必须为 1')
    }
    const dealerIndex = PLAYER_IDS.indexOf(dealerId)
    const expectedChooser = PLAYER_IDS[(dealerIndex + 1) % 4]!
    if (actorId !== expectedChooser) {
      throw new InvalidRequestError('opening-color 阶段行动者必须是庄家左侧玩家')
    }
  }

  return view
}

interface ParsedCandidate {
  id: string
  action: Record<string, unknown>
}

function requireCandidate(value: unknown, where: string): ParsedCandidate {
  if (!isPlainObject(value)) {
    throw new InvalidRequestError(`${where} 必须是对象`)
  }
  requireExactKeys(value, ['id', 'action'], where)
  const id = requireString(value.id, `${where}.id`, AI_CANDIDATE_ID_MAX_LENGTH)
  if (!AI_CANDIDATE_ID_PATTERN.test(id)) {
    throw new InvalidRequestError(`${where}.id 只能包含小写字母、数字与下划线`)
  }
  const action = value.action
  if (!isPlainObject(action)) {
    throw new InvalidRequestError(`${where}.action 必须是对象`)
  }
  const type = requireEnum(action.type, `${where}.action.type`, ['play', 'draw-one', 'keep-drawn', 'choose-opening-color'] as const)
  switch (type) {
    case 'play': {
      const keys = 'chosenColor' in action ? ['type', 'cardId', 'chosenColor', 'declareUno'] : ['type', 'cardId', 'declareUno']
      requireExactKeys(action, keys, `${where}.action`)
      requireString(action.cardId, `${where}.action.cardId`, 32)
      if ('chosenColor' in action) {
        requireColor(action.chosenColor, `${where}.action.chosenColor`)
      }
      if (typeof action.declareUno !== 'boolean') {
        throw new InvalidRequestError(`${where}.action.declareUno 必须是布尔值`)
      }
      break
    }
    case 'draw-one':
    case 'keep-drawn':
      requireExactKeys(action, ['type'], `${where}.action`)
      break
    case 'choose-opening-color':
      requireExactKeys(action, ['type', 'color'], `${where}.action`)
      requireColor(action.color, `${where}.action.color`)
      break
  }
  return { id, action }
}

/** 深比较候选动作是否与重推导结果一致。 */
function actionsEqual(a: Record<string, unknown>, b: Candidate['action']): boolean {
  const aKeys = Object.keys(a).sort()
  const bObj = b as unknown as Record<string, unknown>
  const bKeys = Object.keys(bObj).sort()
  if (aKeys.length !== bKeys.length) {
    return false
  }
  return aKeys.every(key => a[key] === bObj[key])
}

export function buildUpstreamPayload(
  model: string,
  view: AiView,
  candidates: readonly Candidate[],
): { model: string, state: AiView, questions: { choose_action: { type: 'choice', instructions: string, criteria: Record<string, string> } } } {
  const ctx = buildDecisionContextFromView(view)
  if (!ctx) {
    throw new InvalidRequestError('view 处于不可决策阶段')
  }
  const criteria: Record<string, string> = {}
  for (const candidate of candidates) {
    criteria[candidate.id] = describeCandidate(ctx, candidate)
  }
  return {
    model,
    state: view,
    questions: {
      choose_action: {
        type: 'choice',
        instructions: CHOOSE_ACTION_INSTRUCTIONS,
        criteria,
      },
    },
  }
}

function errorResult(status: number, code: AiErrorCode, decisionId?: string, extraHeaders: Record<string, string> = {}): AiDecisionHandlerResult {
  return {
    status,
    headers: { 'Cache-Control': 'no-store', ...extraHeaders },
    body: { error: { code }, ...(decisionId !== undefined ? { decisionId } : {}) },
  }
}

function sameOrigin(origin: string | null, host: string | null): boolean {
  if (!origin || !host || origin === 'null') {
    return false
  }
  let originHost: string
  try {
    originHost = new URL(origin).host
  }
  catch {
    return false
  }
  return originHost.toLowerCase() === host.toLowerCase()
}

/**
 * 处理一次 AI 决策请求。
 * 全流程：Origin / Content-Type / 体积 → 严格字段校验 → 视角自洽性 →
 * 候选集重推导比对 → 构造上游 payload → 调用 TypeSafe → 校验响应 → 回映。
 */
export async function handleAiDecision(params: AiDecisionHandlerParams): Promise<AiDecisionHandlerResult> {
  const startedAt = Date.now()
  const fetchImpl = params.fetchImpl ?? (globalThis.fetch.bind(globalThis) as typeof fetch)
  const upstreamTimeoutMs = params.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS
  const log = params.log ?? (() => {})
  const finishLog = (entry: Omit<AiDecisionLogEntry, 'event' | 'durationMs'>) => {
    log({ event: 'ai_decision', durationMs: Date.now() - startedAt, ...entry })
  }

  // 1. 同源 Origin：限定本站，不是身份认证或付费防滥用措施
  if (!sameOrigin(params.origin, params.host)) {
    finishLog({ level: 'error', status: 403, code: 'forbidden_origin' })
    return errorResult(403, 'forbidden_origin')
  }
  // 2. JSON 内容类型
  if (!params.contentType || !params.contentType.toLowerCase().startsWith('application/json')) {
    finishLog({ level: 'error', status: 400, code: 'invalid_request' })
    return errorResult(400, 'invalid_request')
  }
  // 3. 请求体上限 64 KiB
  const declaredLength = params.contentLength !== null ? Number.parseInt(params.contentLength, 10) : Number.NaN
  if (Number.isSafeInteger(declaredLength) && declaredLength > AI_REQUEST_BODY_LIMIT_BYTES) {
    finishLog({ level: 'error', status: 400, code: 'invalid_request' })
    return errorResult(400, 'invalid_request')
  }
  if (byteLength(params.bodyText) > AI_REQUEST_BODY_LIMIT_BYTES) {
    finishLog({ level: 'error', status: 400, code: 'invalid_request' })
    return errorResult(400, 'invalid_request')
  }

  // 4. 解析与严格校验
  let parsed: unknown
  try {
    parsed = JSON.parse(params.bodyText)
  }
  catch {
    finishLog({ level: 'error', status: 400, code: 'invalid_request' })
    return errorResult(400, 'invalid_request')
  }

  let request: AiDecisionRequest
  let submittedCandidates: ParsedCandidate[]
  let parsedDecisionId: string | undefined
  try {
    if (!isPlainObject(parsed)) {
      throw new InvalidRequestError('请求体必须是对象')
    }
    requireExactKeys(parsed, ['protocolVersion', 'rulesVersion', 'gameId', 'revision', 'decisionId', 'actorId', 'view', 'candidates'], '请求体')
    if (parsed.protocolVersion !== AI_PROTOCOL_VERSION) {
      throw new InvalidRequestError(`protocolVersion 必须为 ${AI_PROTOCOL_VERSION}`)
    }
    if (parsed.rulesVersion !== AI_RULES_VERSION) {
      throw new InvalidRequestError(`rulesVersion 必须为 ${AI_RULES_VERSION}`)
    }
    const gameId = requireUuid(parsed.gameId, 'gameId')
    const decisionId = requireUuid(parsed.decisionId, 'decisionId')
    parsedDecisionId = decisionId
    const revision = requireSafeInt(parsed.revision, 'revision', 0, Number.MAX_SAFE_INTEGER)
    const actorId = requireEnum(parsed.actorId, 'actorId', ['p1', 'p2', 'p3'] as const)
    const view = requireView(parsed.view)
    if (view.actorId !== actorId) {
      throw new InvalidRequestError('view.actorId 必须与顶层 actorId 一致')
    }

    if (!Array.isArray(parsed.candidates) || parsed.candidates.length < AI_MIN_CANDIDATES || parsed.candidates.length > AI_MAX_CANDIDATES) {
      throw new InvalidRequestError(`candidates 数量必须在 ${AI_MIN_CANDIDATES}..${AI_MAX_CANDIDATES}`)
    }
    submittedCandidates = parsed.candidates.map((candidate, i) => requireCandidate(candidate, `candidates[${i}]`))
    const idSet = new Set(submittedCandidates.map(candidate => candidate.id))
    if (idSet.size !== submittedCandidates.length) {
      throw new InvalidRequestError('candidates ID 必须互不重复')
    }

    request = {
      protocolVersion: AI_PROTOCOL_VERSION,
      rulesVersion: AI_RULES_VERSION,
      gameId,
      revision,
      decisionId,
      actorId,
      view,
      candidates: submittedCandidates.map(c => c as unknown as AiDecisionRequest['candidates'][number]),
    }
  }
  catch (error) {
    if (error instanceof InvalidRequestError) {
      finishLog({ level: 'error', status: 400, code: 'invalid_request', ...(parsedDecisionId !== undefined ? { decisionId: parsedDecisionId } : {}), detail: error.message })
      return errorResult(400, 'invalid_request', parsedDecisionId)
    }
    throw error
  }

  const decisionId = request.decisionId

  // 5. 候选集重推导比对：Worker 根据同一受限视角验证候选动作集合、ID 和动作语义一致
  const ctx = buildDecisionContextFromView(request.view)
  if (!ctx) {
    finishLog({ level: 'error', status: 400, code: 'invalid_request', decisionId })
    return errorResult(400, 'invalid_request', decisionId)
  }
  const expected = enumerateCandidates(ctx)
  const expectedById = new Map(expected.map(candidate => [candidate.id, candidate.action]))
  if (submittedCandidates.length !== expected.length) {
    finishLog({ level: 'error', status: 400, code: 'invalid_request', decisionId })
    return errorResult(400, 'invalid_request', decisionId)
  }
  for (const submitted of submittedCandidates) {
    const expectedAction = expectedById.get(submitted.id)
    if (expectedAction === undefined || !actionsEqual(submitted.action, expectedAction)) {
      finishLog({ level: 'error', status: 400, code: 'invalid_request', decisionId })
      return errorResult(400, 'invalid_request', decisionId)
    }
  }

  // 6. 服务端配置检查：缺 key / 模型走受控错误
  const apiKey = params.runtimeConfig.typesafeApiKey
  const model = params.runtimeConfig.typesafeModel
  if (!apiKey || !model) {
    finishLog({ level: 'error', status: 503, code: 'ai_unavailable', decisionId, requestedModel: model || undefined })
    return errorResult(503, 'ai_unavailable', decisionId)
  }

  // 7. 构造上游 payload 并调用（每决策最多一次上游请求）
  // 超时覆盖响应头与正文读取：计时器在 finally 中统一清理
  const payload = buildUpstreamPayload(model, request.view, expected)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), upstreamTimeoutMs)
  /** 上游调用失败（连接或正文读取）：区分超时与网络 / 协议错误。 */
  const upstreamFailure = (): AiDecisionHandlerResult => {
    if (controller.signal.aborted) {
      finishLog({ level: 'error', status: 504, code: 'ai_timeout', decisionId, requestedModel: model })
      return errorResult(504, 'ai_timeout', decisionId)
    }
    finishLog({ level: 'error', status: 502, code: 'ai_upstream_error', decisionId, requestedModel: model })
    return errorResult(502, 'ai_upstream_error', decisionId)
  }
  try {
    let response: Response
    try {
      response = await fetchImpl(TYPESAFE_ENDPOINT, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
    }
    catch {
      return upstreamFailure()
    }

    // 8. 上游状态码映射
    const statusResult = mapUpstreamStatus(response, { decisionId, model, finishLog })
    if (statusResult !== null) {
      return statusResult
    }

    // 9. 读取并校验上游响应结构（正文读取仍在超时保护内）
    let responseText: string
    try {
      responseText = await response.text()
    }
    catch {
      // 正文读取失败：超时（已 abort）或连接中断
      return upstreamFailure()
    }
    return handleUpstreamBody(responseText, { request, expectedById, decisionId, model, finishLog })
  }
  finally {
    clearTimeout(timer)
  }
}

/** 上游状态码映射；成功（2xx）返回 null 交由正文处理。 */
function mapUpstreamStatus(
  response: Response,
  ctx: { decisionId: string, model: string, finishLog: (entry: Omit<AiDecisionLogEntry, 'event' | 'durationMs'>) => void },
): AiDecisionHandlerResult | null {
  const { decisionId, model, finishLog } = ctx
  if (response.status === 429 || response.status === 529) {
    const retryAfterRaw = response.headers.get('retry-after')
    const retrySeconds = Number.parseInt(retryAfterRaw ?? '', 10)
    const extra: Record<string, string> = Number.isSafeInteger(retrySeconds) && retrySeconds > 0
      ? { 'Retry-After': String(retrySeconds) }
      : {}
    finishLog({ level: 'error', status: 429, code: 'ai_rate_limited', decisionId, requestedModel: model })
    return errorResult(429, 'ai_rate_limited', decisionId, extra)
  }
  if (response.status === 401 || response.status === 403) {
    finishLog({ level: 'error', status: 503, code: 'ai_unavailable', decisionId, requestedModel: model })
    return errorResult(503, 'ai_unavailable', decisionId)
  }
  if (!response.ok) {
    // 422 与其他上游错误
    finishLog({ level: 'error', status: 502, code: 'ai_upstream_error', decisionId, requestedModel: model })
    return errorResult(502, 'ai_upstream_error', decisionId)
  }
  return null
}

/** 解析并校验上游响应正文；结构不合同时按 ai_invalid_response 处理（不透传上游原文）。 */
function handleUpstreamBody(
  responseText: string,
  ctx: {
    request: AiDecisionRequest
    expectedById: Map<string, unknown>
    decisionId: string
    model: string
    finishLog: (entry: Omit<AiDecisionLogEntry, 'event' | 'durationMs'>) => void
  },
): AiDecisionHandlerResult {
  const { request, expectedById, decisionId, model, finishLog } = ctx
  let upstream: unknown
  try {
    upstream = JSON.parse(responseText)
  }
  catch {
    finishLog({ level: 'error', status: 502, code: 'ai_invalid_response', decisionId, requestedModel: model })
    return errorResult(502, 'ai_invalid_response', decisionId)
  }
  if (!isPlainObject(upstream) || typeof upstream.model !== 'string' || upstream.model.length === 0 || upstream.model.length > 64) {
    finishLog({ level: 'error', status: 502, code: 'ai_invalid_response', decisionId, requestedModel: model })
    return errorResult(502, 'ai_invalid_response', decisionId)
  }
  const answers = upstream.answers
  if (!isPlainObject(answers) || !isPlainObject(answers.choose_action)) {
    finishLog({ level: 'error', status: 502, code: 'ai_invalid_response', decisionId, requestedModel: model })
    return errorResult(502, 'ai_invalid_response', decisionId)
  }
  const answer = answers.choose_action
  if (answer.type !== 'choice' || typeof answer.choice !== 'string') {
    finishLog({ level: 'error', status: 502, code: 'ai_invalid_response', decisionId, requestedModel: model })
    return errorResult(502, 'ai_invalid_response', decisionId)
  }
  if (!expectedById.has(answer.choice)) {
    finishLog({ level: 'error', status: 502, code: 'ai_invalid_response', decisionId, requestedModel: model })
    return errorResult(502, 'ai_invalid_response', decisionId)
  }
  const probabilities = answer.probabilities
  if (!isPlainObject(probabilities)) {
    finishLog({ level: 'error', status: 502, code: 'ai_invalid_response', decisionId, requestedModel: model })
    return errorResult(502, 'ai_invalid_response', decisionId)
  }
  const probKeys = Object.keys(probabilities)
  const expectedIds = [...expectedById.keys()]
  if (probKeys.length !== expectedIds.length || !expectedIds.every(id => id in probabilities)) {
    finishLog({ level: 'error', status: 502, code: 'ai_invalid_response', decisionId, requestedModel: model })
    return errorResult(502, 'ai_invalid_response', decisionId)
  }
  let sum = 0
  for (const id of expectedIds) {
    const p = probabilities[id]
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) {
      finishLog({ level: 'error', status: 502, code: 'ai_invalid_response', decisionId, requestedModel: model })
      return errorResult(502, 'ai_invalid_response', decisionId)
    }
    sum += p
  }
  if (Math.abs(sum - 1) > 1e-6) {
    finishLog({ level: 'error', status: 502, code: 'ai_invalid_response', decisionId, requestedModel: model })
    return errorResult(502, 'ai_invalid_response', decisionId)
  }
  const confidence = answer.confidence
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    finishLog({ level: 'error', status: 502, code: 'ai_invalid_response', decisionId, requestedModel: model })
    return errorResult(502, 'ai_invalid_response', decisionId)
  }

  // 10. 日志（仅诊断字段：token 数等；不含 key、payload、上游原文）
  const usage = isPlainObject(upstream.usage) ? upstream.usage : undefined
  const inputTokens = typeof usage?.input_tokens === 'number' && Number.isSafeInteger(usage.input_tokens) ? usage.input_tokens : undefined
  const outputTokens = typeof usage?.output_tokens === 'number' && Number.isSafeInteger(usage.output_tokens) ? usage.output_tokens : undefined

  const body: AiDecisionResponse = {
    protocolVersion: AI_PROTOCOL_VERSION,
    gameId: request.gameId,
    revision: request.revision,
    decisionId,
    actorId: request.actorId,
    actionId: answer.choice,
    source: 'jev',
    model: upstream.model,
  }
  finishLog({
    level: 'info',
    status: 200,
    decisionId,
    requestedModel: model,
    model: upstream.model,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
  })
  return {
    status: 200,
    headers: { 'Cache-Control': 'no-store' },
    body,
  }
}
