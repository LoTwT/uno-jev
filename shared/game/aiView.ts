/**
 * AI 受限视角投影。
 *
 * `projectForAi` 通过白名单逐字段构造新对象，不使用完整存档展开后删除字段的方式；
 * 视角内不含其他玩家手牌、抽牌堆内容、私人草稿或隐藏候选动作（规格：信息投影与候选动作）。
 */
import type { DecidablePhase } from './decision'
import type { Card, Color, DecisionSource, PlayerId, PlayerType, PublicEvent } from './types'
import { getCard } from './cards'

export interface AiViewPlayerInfo {
  id: PlayerId
  name: string
  type: PlayerType
  /** 手牌数量，不含手牌内容。 */
  handCount: number
  /** 公开 UNO 宣告状态。 */
  unoDeclared: boolean
}

export interface AiView {
  actorId: PlayerId
  /** 当前 AI 的完整手牌牌面与 ID。 */
  ownHand: Card[]
  /** 当前决策阶段，只发送可决策的 kind 字符串。 */
  phase: DecidablePhase
  /** 只有本 AI 的 after-draw 才带刚抽到的牌 ID。 */
  drawnCardId?: string
  currentColor: Color | null
  direction: 1 | -1
  currentPlayerId: PlayerId
  dealerId: PlayerId
  /** 公开弃牌堆的牌面顺序（末项为顶牌）。 */
  discardPile: Card[]
  /** 抽牌堆数量；不提供抽牌堆内容。 */
  drawPileCount: number
  /** 固定座位顺序的公开玩家信息。 */
  players: AiViewPlayerInfo[]
  /** 最近最多 12 条公开规则事件。 */
  recentEvents: PublicEvent[]
}

/** 投影保留的最近事件条数上限。 */
export const AI_RECENT_EVENT_LIMIT = 12

/**
 * 构造指定 AI 的受限视角。
 * 仅允许对当前行动者且处于可决策阶段时调用；结束状态不请求 AI。
 */
export function projectForAi(state: {
  players: Array<{ id: PlayerId, type: PlayerType, name: string, hand: string[], unoDeclared: boolean }>
  dealerId: PlayerId
  drawPile: string[]
  discardPile: string[]
  currentColor: Color | null
  direction: 1 | -1
  currentPlayerId: PlayerId
  phase: { kind: string }
  recentEvents: PublicEvent[]
}, actorId: PlayerId): AiView {
  const actor = state.players.find(player => player.id === actorId)
  if (!actor) {
    throw new Error(`projectForAi: 玩家不存在: ${actorId}`)
  }
  const kind = state.phase.kind
  if (kind !== 'opening-color' && kind !== 'turn' && kind !== 'after-draw') {
    throw new Error('projectForAi: 结束状态不请求 AI 决策')
  }
  if (state.currentPlayerId !== actorId) {
    throw new Error('projectForAi: 只为当前行动者投影')
  }

  const view: AiView = {
    actorId,
    ownHand: actor.hand
      .map(id => getCard(id))
      .filter((card): card is Card => card !== null),
    phase: kind,
    currentColor: state.currentColor,
    direction: state.direction,
    currentPlayerId: state.currentPlayerId,
    dealerId: state.dealerId,
    discardPile: state.discardPile
      .map(id => getCard(id))
      .filter((card): card is Card => card !== null),
    drawPileCount: state.drawPile.length,
    players: state.players.map(player => ({
      id: player.id,
      name: player.name,
      type: player.type,
      handCount: player.hand.length,
      unoDeclared: player.unoDeclared,
    })),
    recentEvents: state.recentEvents.slice(-AI_RECENT_EVENT_LIMIT),
  }
  if (kind === 'after-draw') {
    const drawnCardId = (state.phase as { drawnCardId?: string }).drawnCardId
    if (typeof drawnCardId === 'string') {
      view.drawnCardId = drawnCardId
    }
  }
  return view
}

/** 视角内允许出现的 AI 决策来源事件类型（用于白名单校验）。 */
export type { DecisionSource }
