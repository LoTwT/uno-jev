import type {
  ActionErrorCode,
  ActionMeta,
  ActionSubmission,
  ApplyActionResult,
  Card,
  CardId,
  Color,
  DrawReason,
  FinishedResult,
  GameState,
  LegalAction,
  Player,
  PlayerId,
  PublicEvent,
  ValidationResult,
} from './types'
/**
 * 纯 TypeScript UNO 规则引擎。
 *
 * 提供创建对局、验证状态、枚举合法动作、应用动作的独立入口；
 * 所有动作提交都携带 actorId、gameId 与 expectedRevision，
 * 应用动作时重新验证玩家、阶段、牌归属、颜色和宣告条件，
 * 不因 UI 曾高亮或 AI 曾返回该动作而跳过验证（规格：领域模型与状态机）。
 */
import { DECK, DEFAULT_PLAYER_NAMES, DEFAULT_PLAYER_TYPES, getCard, isColor, isWildKind } from './cards'
import { buildDecisionContextFromState, isCardPlayable, isDrawnCardPlayable } from './decision'
import { COLORS, PLAYER_IDS } from './types'

export const RULES_VERSION = 'classic-single-v1' as const
export const RECENT_EVENT_LIMIT = 50
export const BLOCKED_TURN_LIMIT = 4
/** 标准列宽 36 字符 UUID（8-4-4-4-12，十六进制）。 */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface CreateGameOptions {
  /** 随机输入由外部注入以便测试；洗牌与选庄家都使用它。 */
  random?: () => number
  /** 测试可注入固定 gameId；生产使用 crypto.randomUUID。 */
  gameId?: string
}

export interface DealGameOptions {
  gameId: string
  dealerId: PlayerId
  /** 发牌前的完整有序牌堆（108 张），末项最先被发出。 */
  drawPile: CardId[]
  /** 起始牌为 +4 时，将其放回剩余抽牌堆后洗匀所用的随机输入。 */
  random?: () => number
}

// ---------------------------------------------------------------------------
// 通用工具

/** Fisher-Yates 洗牌；不修改输入数组。 */
export function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const arr = [...items]
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    const tmp = arr[i]!
    arr[i] = arr[j]!
    arr[j] = tmp
  }
  return arr
}

/** 沿当前方向的下一位玩家；direction=1 视为庄家左侧方向。 */
export function nextPlayerOf(players: readonly PlayerId[], direction: 1 | -1, fromId: PlayerId): PlayerId {
  const index = players.indexOf(fromId)
  if (index < 0) {
    throw new Error(`nextPlayerOf: 玩家不存在: ${fromId}`)
  }
  return players[(index + direction + players.length) % players.length]!
}

function nextPlayer(state: Pick<GameState, 'players' | 'direction'>, fromId: PlayerId): PlayerId {
  return nextPlayerOf(PLAYER_IDS, state.direction, fromId)
}

/** 从 fromId 沿当前方向找到第一位 AI（用于固定抓漏者）。 */
function firstAiFrom(state: Pick<GameState, 'players' | 'direction'>, fromId: PlayerId): PlayerId {
  let candidate = nextPlayer(state, fromId)
  for (let guard = 0; guard < 4; guard++) {
    const player = state.players.find(p => p.id === candidate)
    if (player?.type === 'jev') {
      return candidate
    }
    candidate = nextPlayer(state, candidate)
  }
  throw new Error('firstAiFrom: 座位中不存在 AI')
}

function getPlayer(state: Pick<GameState, 'players'>, id: PlayerId): Player {
  const player = state.players.find(p => p.id === id)
  if (!player) {
    throw new Error(`getPlayer: 玩家不存在: ${id}`)
  }
  return player
}

function topCardIdOf(state: Pick<GameState, 'discardPile'>): CardId {
  const top = state.discardPile[state.discardPile.length - 1]
  if (!top) {
    throw new Error('topCardIdOf: 弃牌堆为空')
  }
  return top
}

function fail(error: ActionErrorCode, message: string): ApplyActionResult {
  return { ok: false, error, message }
}

// ---------------------------------------------------------------------------
// 创建对局

/**
 * 底层发牌入口：给定精确牌堆顺序与庄家，确定 28 张手牌、起始牌及其效果。
 * createGame 用注入随机完成洗牌与均匀选庄家后调用它；
 * 测试用它构造确定牌序（规格：牌组、座位与开局）。
 */
export function dealGame(options: DealGameOptions): GameState {
  const { gameId, dealerId } = options
  const random = options.random ?? Math.random

  if (drawCount(options.drawPile) !== DECK.length) {
    throw new Error('dealGame: 牌堆必须恰好包含 108 张目录内且互不重复的牌')
  }
  if (!PLAYER_IDS.includes(dealerId)) {
    throw new Error(`dealGame: 非法庄家座位: ${dealerId}`)
  }

  const players: Player[] = PLAYER_IDS.map(id => ({
    id,
    type: DEFAULT_PLAYER_TYPES[id],
    name: DEFAULT_PLAYER_NAMES[id],
    hand: [],
    unoDeclared: false,
  }))

  const pile = [...options.drawPile]
  // 每人 7 张，从庄家左侧开始轮转发出；末项先发。
  let dealingSeat = nextPlayerOf(PLAYER_IDS, 1, dealerId)
  for (let round = 0; round < 7; round++) {
    for (let seat = 0; seat < 4; seat++) {
      getPlayer({ players }, dealingSeat).hand.push(pile.pop()!)
      dealingSeat = nextPlayerOf(PLAYER_IDS, 1, dealingSeat)
    }
  }

  // 翻起始牌；+4 不进入弃牌堆、不产生罚牌：
  // 先从剩余牌中确定替代起始牌，再把翻出的 +4 放回剩余抽牌堆洗匀。
  let openingId = pile.pop()!
  const setAside: CardId[] = []
  while (getCard(openingId)?.kind === 'wild-draw-four') {
    setAside.push(openingId)
    openingId = pile.pop()!
  }
  if (setAside.length > 0) {
    pile.push(...setAside)
    const shuffled = shuffle(pile, random)
    pile.length = 0
    pile.push(...shuffled)
  }

  const opening = getCard(openingId)!
  const events: PublicEvent[] = []
  const state: GameState = {
    gameId,
    rulesVersion: RULES_VERSION,
    revision: 0,
    players,
    dealerId,
    drawPile: pile,
    discardPile: [openingId],
    currentColor: null,
    direction: 1,
    currentPlayerId: dealerId,
    phase: { kind: 'turn' },
    blockedTurnCount: 0,
    recentEvents: [],
  }

  const dealerLeft = nextPlayerOf(PLAYER_IDS, 1, dealerId)
  events.push({ revision: 0, type: 'game-started', dealerId, openingCardId: openingId })

  switch (opening.kind) {
    case 'number':
      state.currentColor = opening.color
      state.currentPlayerId = dealerLeft
      break
    case 'skip':
      state.currentColor = opening.color
      state.currentPlayerId = nextPlayerOf(PLAYER_IDS, 1, dealerLeft)
      events.push({ revision: 0, type: 'player-skipped', playerId: dealerLeft, reason: 'opening-skip' })
      break
    case 'reverse':
      // 方向改为 -1，庄家先行动，然后沿反方向继续（规格：起始牌处理表）。
      state.currentColor = opening.color
      state.direction = -1
      state.currentPlayerId = dealerId
      break
    case 'draw-two':
      state.currentColor = opening.color
      drawCards(state, dealerLeft, 2, 'opening-draw-two', events, random)
      events.push({ revision: 0, type: 'player-skipped', playerId: dealerLeft, reason: 'opening-draw-two' })
      state.currentPlayerId = nextPlayerOf(PLAYER_IDS, 1, dealerLeft)
      break
    case 'wild':
      // 庄家左侧玩家先选颜色，然后仍由该玩家正常行动；选色属于独立开局阶段。
      state.currentColor = null
      state.currentPlayerId = dealerLeft
      state.phase = { kind: 'opening-color' }
      break
    default:
      throw new Error('dealGame: 起始牌不可能是 wild-draw-four')
  }

  state.recentEvents = events.slice(-RECENT_EVENT_LIMIT)
  return state
}

/** 校验牌堆：全部命中目录且互不重复。 */
function drawCount(pile: readonly CardId[]): number {
  const seen = new Set<string>()
  for (const id of pile) {
    if (!getCard(id) || seen.has(id)) {
      return -1
    }
    seen.add(id)
  }
  return seen.size
}

/** 创建对局：均匀随机选庄家、Fisher-Yates 洗牌后发牌。 */
export function createGame(options: CreateGameOptions = {}): GameState {
  const random = options.random ?? Math.random
  const gameId = options.gameId ?? (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-fallback`)
  const dealerId = PLAYER_IDS[Math.floor(random() * PLAYER_IDS.length)]!
  const shuffled = shuffle(DECK.map(card => card.id), random)
  return dealGame({ gameId, dealerId, drawPile: shuffled, random })
}

// ---------------------------------------------------------------------------
// 状态验证（存档加载与测试断言共用）

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 全面验证状态不变量。加载存档与测试都使用它；
 * 通过不代表状态必然可达，但不通过一定不能进入可交互状态。
 */
export function validateState(state: unknown): ValidationResult {
  const errors: string[] = []
  if (!isPlainObject(state)) {
    return { ok: false, errors: ['状态必须是对象'] }
  }

  if (typeof state.gameId !== 'string' || !UUID_PATTERN.test(state.gameId)) {
    errors.push('gameId 必须是标准 36 字符 UUID')
  }
  if (state.rulesVersion !== RULES_VERSION) {
    errors.push(`rulesVersion 必须为 ${RULES_VERSION}`)
  }
  if (!Number.isSafeInteger(state.revision) || (state.revision as number) < 0) {
    errors.push('revision 必须是非负安全整数')
  }

  if (!Array.isArray(state.players) || state.players.length !== 4) {
    errors.push('players 必须固定 4 个座位')
  }
  else {
    for (let i = 0; i < 4; i++) {
      const player = state.players[i] as unknown
      if (!isPlainObject(player) || player.id !== PLAYER_IDS[i]) {
        errors.push(`players[${i}].id 必须为 ${PLAYER_IDS[i]}（座位顺序固定）`)
        continue
      }
      if (player.type !== DEFAULT_PLAYER_TYPES[PLAYER_IDS[i]!]) {
        errors.push(`players[${i}].type 必须为 ${DEFAULT_PLAYER_TYPES[PLAYER_IDS[i]!]}`)
      }
      if (typeof player.name !== 'string' || player.name.length === 0 || player.name.length > 32) {
        errors.push(`players[${i}].name 必须为 1..32 字符`)
      }
      if (typeof player.unoDeclared !== 'boolean') {
        errors.push(`players[${i}].unoDeclared 必须为布尔值`)
      }
      if (!Array.isArray(player.hand) || !player.hand.every(id => typeof id === 'string' && getCard(id) !== null)) {
        errors.push(`players[${i}].hand 必须是目录内 CardId 数组`)
      }
      else if (player.unoDeclared === true && (player.hand as string[]).length !== 1) {
        errors.push(`players[${i}].unoDeclared 仅在剩 1 张时可为 true`)
      }
    }
    const humanCount = state.players.filter(p => isPlainObject(p) && p.type === 'human').length
    if (humanCount !== 1) {
      errors.push('必须恰好 1 位真人')
    }
  }

  if (!PLAYER_IDS.includes(state.dealerId as PlayerId)) {
    errors.push('dealerId 必须是合法座位')
  }
  if (state.direction !== 1 && state.direction !== -1) {
    errors.push('direction 必须为 1 或 -1')
  }
  if (!PLAYER_IDS.includes(state.currentPlayerId as PlayerId)) {
    errors.push('currentPlayerId 必须是合法座位')
  }

  const allCardIds: string[] = []
  if (isPlainObject(state)) {
    for (const key of ['drawPile', 'discardPile'] as const) {
      const pile = state[key]
      if (!Array.isArray(pile) || !pile.every(id => typeof id === 'string' && getCard(id) !== null)) {
        errors.push(`${key} 必须是目录内 CardId 数组`)
      }
      else {
        allCardIds.push(...(pile as string[]))
      }
    }
    if (isPlainObject(state) && Array.isArray(state.players)) {
      for (const player of state.players as unknown[]) {
        if (isPlainObject(player) && Array.isArray(player.hand)) {
          allCardIds.push(...(player.hand as string[]))
        }
      }
    }
  }
  if (allCardIds.length !== DECK.length) {
    errors.push(`全部牌数必须恰好 ${DECK.length} 张，实际 ${allCardIds.length}`)
  }
  else if (new Set(allCardIds).size !== DECK.length) {
    errors.push('牌 ID 在手牌与两堆之间必须恰好出现一次')
  }
  if (Array.isArray(state.discardPile) && (state.discardPile as string[]).length === 0) {
    errors.push('弃牌堆必须非空')
  }

  if (!Array.isArray(state.recentEvents) || state.recentEvents.length > RECENT_EVENT_LIMIT) {
    errors.push(`recentEvents 必须是不超过 ${RECENT_EVENT_LIMIT} 条的数组`)
  }
  else if (typeof state.revision === 'number') {
    for (const event of state.recentEvents as unknown[]) {
      const revisionOk = isPlainObject(event)
        && typeof event.revision === 'number'
        && Number.isSafeInteger(event.revision)
        && event.revision <= state.revision
      if (!isPlainObject(event) || typeof event.type !== 'string' || !revisionOk) {
        errors.push('recentEvents 内含非法事件')
        break
      }
    }
  }

  if (!Number.isSafeInteger(state.blockedTurnCount) || (state.blockedTurnCount as number) < 0) {
    errors.push('blockedTurnCount 必须是非负整数')
  }

  // 阶段相关验证
  const phase = state.phase
  const isFinished = isPlainObject(phase) && phase.kind === 'finished'
  if (!isFinished && (state.blockedTurnCount as number) > BLOCKED_TURN_LIMIT - 1) {
    errors.push('未结束状态 blockedTurnCount 必须为 0..3')
  }
  if (!isFinished && Array.isArray(state.players)) {
    for (const player of state.players as Array<{ id: string, hand?: string[] }>) {
      if (Array.isArray(player.hand) && player.hand.length === 0) {
        errors.push(`未结束时任何玩家手牌都非空（${player.id}）`)
      }
    }
  }

  const discardTop = Array.isArray(state.discardPile) ? (state.discardPile as string[]).at(-1) : undefined
  const topCard = discardTop ? getCard(discardTop) : null

  if (isPlainObject(phase)) {
    switch (phase.kind) {
      case 'opening-color': {
        if (state.currentColor !== null) {
          errors.push('opening-color 阶段 currentColor 必须为 null')
        }
        if (topCard?.kind !== 'wild') {
          errors.push('opening-color 阶段弃牌堆顶牌必须是 Wild')
        }
        if (state.direction !== 1) {
          errors.push('opening-color 阶段方向必须为 1')
        }
        const expectedChooser = nextPlayerOf(PLAYER_IDS, 1, state.dealerId as PlayerId)
        if (state.currentPlayerId !== expectedChooser) {
          errors.push('opening-color 阶段行动者必须是庄家左侧玩家')
        }
        break
      }
      case 'turn': {
        if (!isColor(state.currentColor)) {
          errors.push('turn 阶段 currentColor 必须有效')
        }
        break
      }
      case 'after-draw': {
        if (!isColor(state.currentColor)) {
          errors.push('after-draw 阶段 currentColor 必须有效')
        }
        const drawnCardId = phase.drawnCardId
        const current = Array.isArray(state.players)
          ? (state.players as Array<{ id: string, hand: string[] }>).find(p => p.id === state.currentPlayerId)
          : undefined
        if (typeof drawnCardId !== 'string' || getCard(drawnCardId) === null) {
          errors.push('after-draw 阶段 drawnCardId 必须是目录内 CardId')
        }
        else if (!current?.hand?.includes(drawnCardId)) {
          errors.push('after-draw.drawnCardId 必须在当前手牌中')
        }
        else if (current) {
          const ctx = buildDecisionContextFromState(state as unknown as GameState)
          if (ctx && !isDrawnCardPlayable(ctx, drawnCardId)) {
            errors.push('after-draw.drawnCardId 必须是可出的牌')
          }
        }
        break
      }
      case 'finished': {
        const result = phase.result
        if (!isPlainObject(result)) {
          errors.push('finished 阶段必须携带 result')
          break
        }
        if (result.reason === 'empty-hand') {
          const winnerId = result.winnerId
          if (!PLAYER_IDS.includes(winnerId as PlayerId)) {
            errors.push('empty-hand 结果必须携带合法 winnerId')
          }
          else if (Array.isArray(state.players)) {
            const emptyHands = (state.players as Array<{ id: string, hand: string[] }>).filter(p => p.hand.length === 0)
            if (emptyHands.length !== 1 || emptyHands[0]?.id !== winnerId) {
              errors.push('空手胜者必须唯一且与 winnerId 一致')
            }
          }
        }
        else if (result.reason === 'blocked') {
          if (result.winnerId !== null) {
            errors.push('blocked 结果 winnerId 必须为 null')
          }
        }
        else {
          errors.push('结束原因必须是 empty-hand 或 blocked')
        }
        break
      }
      default:
        errors.push('phase.kind 必须是已知阶段')
    }
  }
  else {
    errors.push('phase 必须是对象')
  }

  // 有色顶牌的颜色必须与当前颜色一致
  if (topCard && topCard.color !== null && state.currentColor !== null && topCard.color !== state.currentColor) {
    errors.push('有色顶牌的颜色必须与当前颜色一致')
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true }
}

// ---------------------------------------------------------------------------
// 抽牌（含重洗）

/**
 * 抽牌：若抽牌堆不足，先抽完现有牌，再保留弃牌堆顶牌，
 * 将其余弃牌洗成新抽牌堆，继续抽足数量；
 * 连可回收弃牌也没有时只抽实际可用的数量并记录（规格：结算顺序、末张牌与牌堆耗尽）。
 */
function drawCards(
  state: GameState,
  playerId: PlayerId,
  requested: number,
  reason: DrawReason,
  events: PublicEvent[],
  random: () => number,
): number {
  const player = getPlayer(state, playerId)
  let drawn = 0
  while (drawn < requested) {
    if (state.drawPile.length === 0) {
      if (state.discardPile.length <= 1) {
        break
      }
      const top = state.discardPile.pop()!
      const recycled = shuffle(state.discardPile, random)
      state.drawPile = recycled
      state.discardPile = [top]
      events.push({ revision: state.revision, type: 'pile-reshuffled', recycledCount: recycled.length })
    }
    player.hand.push(state.drawPile.pop()!)
    drawn++
  }
  if (drawn > 0) {
    // 抽牌重新持有超过 1 张时清除宣告状态
    player.unoDeclared = false
  }
  events.push({ revision: state.revision, type: 'cards-drawn', playerId, requested, drawn, reason })
  return drawn
}

// ---------------------------------------------------------------------------
// 枚举合法动作

/**
 * 枚举指定玩家的合法动作。
 * 非当前行动者或已结束时返回空数组。
 * 出到剩 1 张时同时给出 declareUno 为 false 与 true 两个变体（两者都是合法提交）；
 * AI 候选枚举（candidates.ts）在此基础上收敛为"仅宣告"的约定。
 */
export function listLegalActions(state: GameState, playerId: PlayerId): LegalAction[] {
  if (state.phase.kind === 'finished') {
    return []
  }
  if (playerId !== state.currentPlayerId) {
    return []
  }
  if (state.phase.kind === 'opening-color') {
    return COLORS.map(color => ({ type: 'choose-opening-color', color }) as LegalAction)
  }

  const actor = getPlayer(state, playerId)
  const ctx = buildDecisionContextFromState(state)
  if (!ctx) {
    return []
  }

  const actions: LegalAction[] = []
  const addPlayVariants = (card: Card) => {
    const unoVariants: boolean[] = actor.hand.length === 2 ? [false, true] : [false]
    const colorVariants: Array<Color | undefined> = isWildKind(card.kind) ? [...COLORS] : [undefined]
    for (const uno of unoVariants) {
      for (const color of colorVariants) {
        actions.push(color === undefined
          ? { type: 'play', cardId: card.id, declareUno: uno }
          : { type: 'play', cardId: card.id, chosenColor: color, declareUno: uno })
      }
    }
  }

  if (state.phase.kind === 'after-draw') {
    const drawnCard = getCard(state.phase.drawnCardId)
    if (drawnCard && isCardPlayable(ctx, drawnCard)) {
      addPlayVariants(drawnCard)
    }
    actions.push({ type: 'keep-drawn' })
    return actions
  }

  for (const cardId of actor.hand) {
    const card = getCard(cardId)!
    if (isCardPlayable(ctx, card)) {
      addPlayVariants(card)
    }
  }
  actions.push({ type: 'draw-one' })
  return actions
}

// ---------------------------------------------------------------------------
// 应用动作

export interface ApplyActionOptions {
  /** 重洗弃牌堆时使用的随机输入；测试可注入固定序列。 */
  random?: () => number
  /** 会话层附加的 AI 决策来源，随本次动作原子记录。 */
  meta?: ActionMeta
}

/**
 * 应用动作：先重新验证全部前置条件，再原子结算。
 * 返回新状态与本次产生的公开事件；失败时返回错误码，原状态不受影响。
 */
export function applyAction(
  state: GameState,
  submission: ActionSubmission,
  options: ApplyActionOptions = {},
): ApplyActionResult {
  if (submission.gameId !== state.gameId) {
    return fail('game-id-mismatch', `gameId 不匹配：期望 ${state.gameId}`)
  }
  if (submission.expectedRevision !== state.revision) {
    return fail('stale-revision', `revision 不匹配：期望 ${state.revision}，提交 ${submission.expectedRevision}`)
  }
  if (state.phase.kind === 'finished') {
    return fail('invalid-phase', '对局已结束')
  }
  if (submission.actorId !== state.currentPlayerId) {
    return fail('not-your-turn', `${submission.actorId} 不是当前行动者`)
  }

  const random = options.random ?? Math.random
  const next: GameState = structuredClone(state)
  const events: PublicEvent[] = []
  next.revision += 1

  if (options.meta?.aiSource) {
    events.push({
      revision: next.revision,
      type: 'decision-source',
      playerId: submission.actorId,
      source: options.meta.aiSource,
      ...(options.meta.fallbackReason !== undefined ? { reason: options.meta.fallbackReason } : {}),
    })
  }

  const actor = getPlayer(next, submission.actorId)
  const action = submission.action

  switch (action.type) {
    case 'play':
      return applyPlay(state, next, actor, action, events, random)
    case 'draw-one':
      return applyDrawOne(next, actor, events, random)
    case 'keep-drawn':
      return applyKeepDrawn(next, actor, events)
    case 'choose-opening-color':
      return applyChooseOpeningColor(next, actor, action, events)
    default:
      return fail('unknown-action', `未知动作类型: ${(action as { type: string }).type}`)
  }
}

function applyPlay(
  original: GameState,
  next: GameState,
  actor: Player,
  action: Extract<LegalAction, { type: 'play' }>,
  events: PublicEvent[],
  random: () => number,
): ApplyActionResult {
  if (next.phase.kind !== 'turn' && next.phase.kind !== 'after-draw') {
    return fail('invalid-phase', `当前阶段 ${next.phase.kind} 不能出牌`)
  }
  if (next.phase.kind === 'after-draw' && action.cardId !== next.phase.drawnCardId) {
    return fail('not-drawn-card', '抽牌后只能出刚抽到的这张牌')
  }
  if (!actor.hand.includes(action.cardId)) {
    return fail('card-not-in-hand', `手牌中不存在 ${action.cardId}`)
  }
  const card = getCard(action.cardId)
  if (!card) {
    return fail('card-not-in-hand', `未知牌 ID: ${action.cardId}`)
  }
  const ctx = buildDecisionContextFromState(next)
  if (!ctx || !isCardPlayable(ctx, card)) {
    return fail('card-not-playable', `${action.cardId} 在当前局面不可出`)
  }
  if (isWildKind(card.kind)) {
    if (!isColor(action.chosenColor)) {
      return fail('invalid-chosen-color', 'Wild 类出牌必须携带有效选色')
    }
  }
  else if (action.chosenColor !== undefined) {
    return fail('invalid-chosen-color', '普通有色牌禁止携带 chosenColor')
  }
  // declareUno 只在本次出牌后剩 1 张时合法；其他手牌数量携带 true 一律拒绝。
  if (action.declareUno && actor.hand.length !== 2) {
    return fail('invalid-uno-declaration', '宣告 UNO 只在剩 2 张出 1 张时可用')
  }

  // --- 提交：移牌并设置颜色 / 方向 ---
  actor.hand.splice(actor.hand.indexOf(action.cardId), 1)
  next.discardPile.push(action.cardId)
  // Wild 类在上面的校验中已保证携带有效 chosenColor
  const chosenColor: Color = card.color !== null ? card.color : action.chosenColor!
  next.currentColor = chosenColor

  events.push({
    revision: next.revision,
    type: 'card-played',
    playerId: actor.id,
    cardId: action.cardId,
    ...(isWildKind(card.kind) ? { chosenColor: action.chosenColor } : {}),
  })

  if (card.kind === 'reverse') {
    next.direction = next.direction === 1 ? -1 : 1
    events.push({ revision: next.revision, type: 'direction-reversed', byPlayerId: actor.id })
  }

  // --- UNO 宣告或抓漏罚抽 ---
  if (action.declareUno) {
    actor.unoDeclared = true
    events.push({ revision: next.revision, type: 'uno-declared', playerId: actor.id })
  }
  else if (actor.hand.length === 1) {
    // 漏喊：当前方向的下一位 AI 在转交回合前抓到，罚抽 2 张，同一动作内结算。
    const catcher = firstAiFrom(next, actor.id)
    events.push({
      revision: next.revision,
      type: 'uno-miss-caught',
      playerId: actor.id,
      caughtBy: catcher,
      penaltyCount: 2,
    })
    drawCards(next, actor.id, 2, 'uno-miss', events, random)
  }

  // --- 功能牌对下一位的影响 ---
  let nextActorId: PlayerId
  switch (card.kind) {
    case 'number':
    case 'wild':
    case 'reverse':
      nextActorId = nextPlayer(next, actor.id)
      break
    case 'skip': {
      const skipped = nextPlayer(next, actor.id)
      events.push({ revision: next.revision, type: 'player-skipped', playerId: skipped, reason: 'skip' })
      nextActorId = nextPlayer(next, skipped)
      break
    }
    case 'draw-two': {
      const target = nextPlayer(next, actor.id)
      drawCards(next, target, 2, 'draw-two', events, random)
      events.push({ revision: next.revision, type: 'player-skipped', playerId: target, reason: 'draw-two' })
      nextActorId = nextPlayer(next, target)
      break
    }
    case 'wild-draw-four': {
      const target = nextPlayer(next, actor.id)
      drawCards(next, target, 4, 'wild-draw-four', events, random)
      events.push({ revision: next.revision, type: 'player-skipped', playerId: target, reason: 'wild-draw-four' })
      nextActorId = nextPlayer(next, target)
      break
    }
  }

  // --- 胜负与下一行动者 ---
  if (actor.hand.length === 0) {
    // 出完手牌即获胜；宣告状态随最后一并结清
    actor.unoDeclared = false
    const result: FinishedResult = { reason: 'empty-hand', winnerId: actor.id }
    next.phase = { kind: 'finished', result }
    events.push({ revision: next.revision, type: 'game-finished', result })
    // currentPlayerId 保留最后行动者，仅供显示
  }
  else {
    next.currentPlayerId = nextActorId
    next.phase = { kind: 'turn' }
  }
  // 任何成功移牌都重置无进展计数
  next.blockedTurnCount = 0

  finishTransition(next, events)
  return { ok: true, state: next, events }
}

function applyDrawOne(
  next: GameState,
  actor: Player,
  events: PublicEvent[],
  random: () => number,
): ApplyActionResult {
  if (next.phase.kind !== 'turn') {
    return fail('invalid-phase', `当前阶段 ${next.phase.kind} 不能抽牌`)
  }
  const drawn = drawCards(next, actor.id, 1, 'turn', events, random)
  if (drawn === 0) {
    // 正常回合抽不到牌：结束该回合并累计无进展计数
    next.blockedTurnCount += 1
    if (next.blockedTurnCount >= BLOCKED_TURN_LIMIT) {
      const result: FinishedResult = { reason: 'blocked', winnerId: null }
      next.phase = { kind: 'finished', result }
      events.push({ revision: next.revision, type: 'game-finished', result })
    }
    else {
      next.currentPlayerId = nextPlayer(next, actor.id)
      next.phase = { kind: 'turn' }
    }
  }
  else {
    next.blockedTurnCount = 0
    const drawnCardId = actor.hand[actor.hand.length - 1]!
    const ctx = buildDecisionContextFromState(next)
    if (ctx && isDrawnCardPlayable(ctx, drawnCardId)) {
      // 抽到可出牌：留在本人 after-draw，由其决定出或留
      next.phase = { kind: 'after-draw', drawnCardId }
    }
    else {
      // 不可出：直接结束回合，不持续抽到能出为止
      next.currentPlayerId = nextPlayer(next, actor.id)
      next.phase = { kind: 'turn' }
    }
  }
  finishTransition(next, events)
  return { ok: true, state: next, events }
}

function applyKeepDrawn(
  next: GameState,
  actor: Player,
  events: PublicEvent[],
): ApplyActionResult {
  if (next.phase.kind !== 'after-draw') {
    return fail('invalid-phase', `当前阶段 ${next.phase.kind} 不能保留抽牌`)
  }
  events.push({ revision: next.revision, type: 'kept-drawn', playerId: actor.id })
  next.currentPlayerId = nextPlayer(next, actor.id)
  next.phase = { kind: 'turn' }
  // keep-drawn 不增加无进展计数：该回合已经抽到过牌
  finishTransition(next, events)
  return { ok: true, state: next, events }
}

function applyChooseOpeningColor(
  next: GameState,
  actor: Player,
  action: Extract<LegalAction, { type: 'choose-opening-color' }>,
  events: PublicEvent[],
): ApplyActionResult {
  if (next.phase.kind !== 'opening-color') {
    return fail('invalid-phase', `当前阶段 ${next.phase.kind} 不能选开局颜色`)
  }
  if (!isColor(action.color)) {
    return fail('invalid-chosen-color', `非法颜色: ${String(action.color)}`)
  }
  next.currentColor = action.color
  // 保存选色后进入同一玩家的 turn
  next.phase = { kind: 'turn' }
  events.push({ revision: next.revision, type: 'opening-color-chosen', playerId: actor.id, color: action.color })
  finishTransition(next, events)
  return { ok: true, state: next, events }
}

function finishTransition(next: GameState, events: PublicEvent[]): void {
  next.recentEvents.push(...events)
  if (next.recentEvents.length > RECENT_EVENT_LIMIT) {
    next.recentEvents.splice(0, next.recentEvents.length - RECENT_EVENT_LIMIT)
  }
}

export { nextPlayer, topCardIdOf }
