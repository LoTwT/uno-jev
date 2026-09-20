/**
 * 决策上下文与出牌合法性判定。
 *
 * 该模块是"一张牌现在能否出"的唯一判定来源：
 * 规则引擎的动作验证、候选枚举（浏览器）与 Worker 端重推导都使用同一实现，
 * 保证三方的合法动作集合完全一致（规格：AI 决策协议）。
 */
import type { AiView } from './aiView'
import type { Card, CardId, Color, GameState, PlayerId } from './types'
import { getCard, isWildKind } from './cards'

/** 可决策阶段；finished 不请求 AI。 */
export type DecidablePhase = 'opening-color' | 'turn' | 'after-draw'

/**
 * 判定一张牌是否可出的最小上下文。
 * 浏览器从 GameState 构造，Worker 从 AiView 构造，字段语义完全一致。
 */
export interface DecisionContext {
  phase: DecidablePhase
  actorId: PlayerId
  /** 决策者的完整手牌（有序），含 after-draw 时刚抽到的牌。 */
  ownHand: Card[]
  /** 当前有效颜色；opening-color 阶段为 null。 */
  currentColor: Color | null
  /** 弃牌堆顶牌。 */
  topCard: Card
  /** after-draw 阶段刚抽到的牌；其余阶段为 null。 */
  drawnCardId: CardId | null
}

export function isDecidablePhase(phase: GameState['phase']['kind']): phase is DecidablePhase {
  return phase === 'opening-color' || phase === 'turn' || phase === 'after-draw'
}

/** 从完整状态构造当前行动者的决策上下文；finished 阶段视为不可决策。 */
export function buildDecisionContextFromState(state: GameState): DecisionContext | null {
  if (!isDecidablePhase(state.phase.kind)) {
    return null
  }
  const actor = state.players.find(player => player.id === state.currentPlayerId)
  if (!actor) {
    return null
  }
  const topCardId = state.discardPile[state.discardPile.length - 1]
  const topCard = topCardId ? getCard(topCardId) : null
  if (!topCard) {
    return null
  }
  return {
    phase: state.phase.kind,
    actorId: actor.id,
    ownHand: actor.hand.map(id => getCard(id)!).filter(card => card !== null),
    currentColor: state.currentColor,
    topCard,
    drawnCardId: state.phase.kind === 'after-draw' ? state.phase.drawnCardId : null,
  }
}

/** 从受限视角构造同一上下文（Worker 端重推导候选时使用）。 */
export function buildDecisionContextFromView(view: AiView): DecisionContext | null {
  if (!isDecidablePhase(view.phase)) {
    return null
  }
  const topCard = view.discardPile[view.discardPile.length - 1]
  if (!topCard) {
    return null
  }
  return {
    phase: view.phase,
    actorId: view.actorId,
    ownHand: view.ownHand,
    currentColor: view.currentColor,
    topCard,
    drawnCardId: view.drawnCardId ?? null,
  }
}

/** Wild 类出牌必须携带选色，普通有色牌禁止携带。 */
export function chosenColorRequirement(card: Card): 'required' | 'forbidden' {
  return isWildKind(card.kind) ? 'required' : 'forbidden'
}

/**
 * +4 合法性：出牌前的当前颜色下，整手牌（含刚抽到的牌）中
 * 不能有任何与当前颜色相同的有色牌；同数字、同功能但异色，
 * 以及普通 Wild 都不阻止使用（规格：游戏规则）。
 */
export function canPlayWildDrawFour(ctx: DecisionContext): boolean {
  if (ctx.currentColor === null) {
    // opening-color 阶段不存在 +4 出牌决策
    return false
  }
  return !ctx.ownHand.some(card => card.color !== null && card.color === ctx.currentColor)
}

/**
 * 一张牌在当前上下文下是否可出。
 * - 有色牌：匹配当前颜色，或匹配顶牌的数字 / 功能符号（顶牌为 Wild 类时以 currentColor 为准）。
 * - Wild：总是可出。
 * - +4：受 canPlayWildDrawFour 限制。
 */
export function isCardPlayable(ctx: DecisionContext, card: Card): boolean {
  if (card.color !== null) {
    if (ctx.currentColor === null) {
      return false
    }
    if (card.color === ctx.currentColor) {
      return true
    }
    const top = ctx.topCard
    if (isWildKind(top.kind)) {
      return false
    }
    if (top.kind !== card.kind) {
      return false
    }
    return card.kind !== 'number' || top.value === card.value
  }
  return card.kind === 'wild' ? true : canPlayWildDrawFour(ctx)
}

/** 抽 1 张后该牌是否可出（决定进入 after-draw 还是结束回合）。 */
export function isDrawnCardPlayable(ctx: DecisionContext, drawnCardId: CardId): boolean {
  const card = getCard(drawnCardId)
  return card !== null && isCardPlayable(ctx, card)
}
