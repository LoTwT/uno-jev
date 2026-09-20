/**
 * 规则测试共享辅助：定向构造牌堆与快速推进。
 *
 * dealGame 语义：drawPile 末项先发。发牌从庄家左侧（direction=1）开始轮转，
 * 每轮每个座位各 1 张、共 7 轮；发完 28 张后，下一个末项是起始牌。
 */
import type { Card, CardId, Color, GameState, LegalAction, PlayerId } from '#shared/game'
import { applyAction, dealGame, DECK, PLAYER_IDS, validateState } from '#shared/game'

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 庄家左侧开始的座位顺序。 */
export function seatOrderFrom(dealerId: PlayerId): PlayerId[] {
  const start = PLAYER_IDS.indexOf(dealerId)
  return PLAYER_IDS.map((_, i) => PLAYER_IDS[(start + 1 + i) % 4]!)
}

/** 按面值找一张牌的 ID；找不到抛错（用于精确构造）。 */
export function cardOf(spec: { kind: Card['kind'], color?: Color | null, value?: number, copy?: 1 | 2 }): CardId {
  const found = DECK.find((card) => {
    if (card.kind !== spec.kind) {
      return false
    }
    if (spec.color !== undefined && card.color !== spec.color) {
      return false
    }
    if (spec.value !== undefined && card.value !== spec.value) {
      return false
    }
    if (spec.copy !== undefined && !card.id.endsWith(`-${spec.copy}`)) {
      return false
    }
    return true
  })
  if (!found) {
    throw new Error(`cardOf: 目录中找不到 ${JSON.stringify(spec)}`)
  }
  return found.id
}

export interface DealSpec {
  dealerId: PlayerId
  /** 每个座位期望的 7 张手牌（按获得顺序）。 */
  hands: Record<PlayerId, CardId[]>
  /** 期望的起始牌（不可为 wild-draw-four，起始 +4 场景用 openingPlusFours）。 */
  openingId?: CardId
  /** 堆在起始牌位置上方（更靠末尾）的 +4，按先翻出顺序排列。 */
  openingPlusFours?: CardId[]
  gameId?: string
}

/**
 * 构造发牌前的完整牌堆：
 * 末 28 张按轮转发给四家（末项属于庄家左侧玩家的第 1 张），
 * 倒数第 29 张是起始牌；openingPlusFours 叠在起始牌之上（先被翻出）。
 */
export function buildPile(spec: DealSpec): CardId[] {
  const order = seatOrderFrom(spec.dealerId)
  const used = new Set<string>()
  const dealtFromEnd: CardId[] = [] // index 0 = pile 末项
  for (let round = 0; round < 7; round++) {
    for (let seat = 0; seat < 4; seat++) {
      const pid = order[seat]!
      const cardId = spec.hands[pid]![round]!
      if (used.has(cardId)) {
        throw new Error(`buildPile: 牌重复使用 ${cardId}`)
      }
      used.add(cardId)
      dealtFromEnd.push(cardId)
    }
  }
  let openingId = spec.openingId ?? null
  if (openingId) {
    if (used.has(openingId)) {
      throw new Error(`buildPile: 起始牌与手牌重复 ${openingId}`)
    }
    used.add(openingId)
  }
  for (const plus4 of spec.openingPlusFours ?? []) {
    if (used.has(plus4) || !plus4.startsWith('wild-draw-four-')) {
      throw new Error(`buildPile: 无效起始 +4 ${plus4}`)
    }
    used.add(plus4)
  }
  if (!openingId && !(spec.openingPlusFours ?? []).length) {
    throw new Error('buildPile: 需要 openingId 或 openingPlusFours')
  }
  const rest = DECK.map(card => card.id).filter(id => !used.has(id))
  const tail = [...dealtFromEnd].reverse()
  if (!openingId) {
    // 只指定了 +4：起始牌由剩余牌的末项充当（dealGame 会翻过 +4 后抽到它）
    openingId = rest.pop()!
  }
  // pile 末尾依次是：…、（先翻出的 +4）、…、（后翻出的 +4）、起始牌、28 张手牌
  const plusFoursAboveOpening = [...(spec.openingPlusFours ?? [])]
  return [...rest, openingId, ...plusFoursAboveOpening.reverse(), ...tail]
}

/** 定向构造对局并断言初始状态合法。 */
export function makeGame(spec: DealSpec): GameState {
  const state = dealGame({
    gameId: spec.gameId ?? '12345678-1234-5678-1234-567812345678',
    dealerId: spec.dealerId,
    drawPile: buildPile(spec),
    random: mulberry32(9),
  })
  const check = validateState(state)
  if (!check.ok) {
    throw new Error(`makeGame: 初始状态非法: ${check.errors.join('; ')}`)
  }
  return state
}

/** 常用：p0 庄家左侧先手，起始数字牌决定颜色，构造任意 p0 手牌与顶牌。 */
export function makeGameP0First(spec: {
  p0Hand: CardId[]
  openingId: CardId
  p1Hand?: CardId[]
  p2Hand?: CardId[]
  p3Hand?: CardId[]
  openingPlusFours?: CardId[]
}): GameState {
  const fillHand = (prefix: string): CardId[] => {
    const base = DECK.map(c => c.id).filter(id => id.startsWith(prefix))
    return base.slice(0, 7)
  }
  return makeGame({
    dealerId: 'p3', // 庄家左侧 = p0
    openingId: spec.openingId,
    openingPlusFours: spec.openingPlusFours,
    hands: {
      p0: spec.p0Hand,
      p1: spec.p1Hand ?? fillHand('red'),
      p2: spec.p2Hand ?? fillHand('blue'),
      p3: spec.p3Hand ?? fillHand('green'),
    },
  })
}

/** 提交动作的便捷封装；失败返回错误结果供断言。 */
export function submit(
  state: GameState,
  actorId: PlayerId,
  action: LegalAction,
): ReturnType<typeof applyAction> {
  return applyAction(state, {
    actorId,
    gameId: state.gameId,
    expectedRevision: state.revision,
    action,
  })
}

/** 断言动作成功并返回新状态（不合法时抛出含错误信息的异常）。 */
export function submitOk(state: GameState, actorId: PlayerId, action: LegalAction): GameState {
  const result = submit(state, actorId, action)
  if (!result.ok) {
    throw new Error(`动作意外失败 ${actorId} ${JSON.stringify(action)}: ${result.error} ${result.message}`)
  }
  return result.state
}

/** 断言动作被拒绝并返回错误码。 */
export function submitFail(state: GameState, actorId: PlayerId, action: LegalAction): string {
  const result = submit(state, actorId, action)
  if (result.ok) {
    throw new Error(`动作意外成功 ${actorId} ${JSON.stringify(action)}`)
  }
  return result.error
}

/** 读取玩家。 */
export function playerOf(state: GameState, id: PlayerId) {
  return state.players.find(p => p.id === id)!
}

/** 顶牌。 */
export function topCardOf(state: GameState): Card {
  return DECK.find(c => c.id === state.discardPile[state.discardPile.length - 1])!
}

/** 手牌中第一张满足面值的牌 ID。 */
export function inHand(state: GameState, playerId: PlayerId, spec: { kind: Card['kind'], color?: Color, value?: number }): CardId | null {
  const hand = playerOf(state, playerId).hand
  for (const id of hand) {
    const card = DECK.find(c => c.id === id)!
    if (card.kind === spec.kind
      && (spec.color === undefined || card.color === spec.color)
      && (spec.value === undefined || card.value === spec.value)) {
      return id
    }
  }
  return null
}
