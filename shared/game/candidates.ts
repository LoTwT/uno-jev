import type { DecisionContext } from './decision'
import type { CardId, Color, GameState, LegalAction, PlayerId } from './types'
/**
 * AI 候选动作枚举：稳定 ID 与确定性排序。
 *
 * 浏览器先枚举候选再附到请求；Worker 根据同一受限视角重推导候选并比对，
 * 双方使用同一实现，保证"候选动作集合、ID 和动作语义一致"（规格：AI 决策协议）。
 *
 * ID 由动作内容生成（draw_one / keep_drawn / opening_color_<color> /
 * play_<cardId>_<color-or-none>_<uno-or-no_uno>），不依赖显示顺序、随机数或
 * 模型返回下标；同一快照重复枚举得到相同 ID 与排序，颜色顺序固定为红、黄、绿、蓝。
 */
import { getCard, isWildKind } from './cards'
import { buildDecisionContextFromState, isCardPlayable } from './decision'
import { COLORS } from './types'

export interface Candidate {
  id: string
  action: LegalAction
}

function colorSegment(color: Color | undefined): string {
  return color ?? 'none'
}

function unoSegment(declareUno: boolean): string {
  return declareUno ? 'uno' : 'no_uno'
}

export function candidateIdOf(action: LegalAction): string {
  switch (action.type) {
    case 'play':
      return `play_${action.cardId}_${colorSegment(action.chosenColor)}_${unoSegment(action.declareUno)}`
    case 'draw-one':
      return 'draw_one'
    case 'keep-drawn':
      return 'keep_drawn'
    case 'choose-opening-color':
      return `opening_color_${action.color}`
  }
}

/**
 * 枚举当前决策上下文的 AI 候选。
 * - 候选完整覆盖当前可选动作，不添加 other 或虚构动作。
 * - Wild 的四种选色分别是候选；AI 的 UNO 宣告由代码补齐，
 *   仅在本次出牌后剩 1 张时取 true，候选不包括故意漏喊。
 * - 普通回合保留 draw-one；抽后阶段保留 keep-drawn。
 * - 排序确定：手牌顺序、Wild 选色固定红黄绿蓝、末尾为抽 / 留动作。
 */
export function enumerateCandidates(ctx: DecisionContext): Candidate[] {
  const candidates: Candidate[] = []
  const handSize = ctx.ownHand.length

  if (ctx.phase === 'opening-color') {
    for (const color of COLORS) {
      const action: LegalAction = { type: 'choose-opening-color', color }
      candidates.push({ id: candidateIdOf(action), action })
    }
    return candidates
  }

  const addPlayCandidates = (cardId: CardId) => {
    const card = getCard(cardId)
    if (!card) {
      return
    }
    const declareUno = handSize === 2
    if (isWildKind(card.kind)) {
      for (const color of COLORS) {
        const action: LegalAction = { type: 'play', cardId, chosenColor: color, declareUno }
        candidates.push({ id: candidateIdOf(action), action })
      }
    }
    else {
      const action: LegalAction = { type: 'play', cardId, declareUno }
      candidates.push({ id: candidateIdOf(action), action })
    }
  }

  if (ctx.phase === 'after-draw') {
    const drawnCardId = ctx.drawnCardId
    if (drawnCardId && isCardPlayable(ctx, getCard(drawnCardId)!)) {
      addPlayCandidates(drawnCardId)
    }
    candidates.push({ id: 'keep_drawn', action: { type: 'keep-drawn' } })
    return candidates
  }

  for (const card of ctx.ownHand) {
    if (isCardPlayable(ctx, card)) {
      addPlayCandidates(card.id)
    }
  }
  candidates.push({ id: 'draw_one', action: { type: 'draw-one' } })
  return candidates
}

/**
 * 从完整状态枚举当前行动者的候选。
 * 结束阶段返回 null（不请求 AI）。
 */
export function enumerateCandidatesFromState(state: GameState): Candidate[] | null {
  const ctx = buildDecisionContextFromState(state)
  if (!ctx) {
    return null
  }
  return enumerateCandidates(ctx)
}

/** 按 ID 查找候选；未命中返回 null。 */
export function findCandidateById(candidates: readonly Candidate[], id: string): Candidate | null {
  return candidates.find(candidate => candidate.id === id) ?? null
}

export type { PlayerId }
