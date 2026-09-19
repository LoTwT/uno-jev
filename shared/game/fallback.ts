import type { Candidate } from './candidates'
import type { DecisionContext } from './decision'
import type { Card, Color } from './types'
/**
 * 确定性规则兜底策略。
 *
 * 只接收同一 AiView 派生的决策上下文与当前合法候选，不能读取暗牌；
 * 不调用随机数，相同输入必得相同结果（规格：超时、兜底与过期响应）。
 *
 * 固定排序：能立即出完的动作优先；否则优先出牌，按
 * "出牌后该颜色的剩余手牌数降序、牌类 +4 > +2 > Skip > Reverse > 数字 > Wild、
 * 数字降序、颜色红黄绿蓝、CardId 字典序"打破平局；
 * Wild 选色按剩余有色手牌数最多优先，平局按固定颜色顺序；开局选色同理。
 * 无可出牌时选抽牌，抽后只在没有可出候选时保留。
 */
import { getCard } from './cards'
import { COLORS } from './types'

const CLASS_RANK: Record<Card['kind'], number> = {
  'wild-draw-four': 0,
  'draw-two': 1,
  'skip': 2,
  'reverse': 3,
  'number': 4,
  'wild': 5,
}

const COLOR_RANK: Record<Color, number> = {
  red: 0,
  yellow: 1,
  green: 2,
  blue: 3,
}

/** 剩余手牌中该颜色的数量（不含将被出的牌）。 */
function remainingColorCount(hand: readonly Card[], playedId: string, color: Color): number {
  return hand.filter(card => card.id !== playedId && card.color === color).length
}

interface PlayRank {
  winning: 0 | 1
  remaining: number
  classRank: number
  value: number
  colorRank: number
  cardId: string
  candidate: Candidate
}

function rankPlayCandidate(ctx: DecisionContext, candidate: Candidate): PlayRank | null {
  if (candidate.action.type !== 'play') {
    return null
  }
  const action = candidate.action
  const card = getCard(action.cardId)
  if (!card) {
    return null
  }
  const relevantColor: Color | null = card.color ?? action.chosenColor ?? null
  return {
    // 能立即出完（手牌只剩这一张）的动作无条件优先
    winning: ctx.ownHand.length === 1 ? 1 : 0,
    remaining: relevantColor ? remainingColorCount(ctx.ownHand, card.id, relevantColor) : 0,
    classRank: CLASS_RANK[card.kind],
    value: card.value ?? -1,
    colorRank: relevantColor ? COLOR_RANK[relevantColor] : 0,
    cardId: card.id,
    candidate,
  }
}

function comparePlays(a: PlayRank, b: PlayRank): number {
  if (a.winning !== b.winning)
    return b.winning - a.winning
  if (a.remaining !== b.remaining)
    return b.remaining - a.remaining
  if (a.classRank !== b.classRank)
    return a.classRank - b.classRank
  if (a.value !== b.value)
    return b.value - a.value
  if (a.colorRank !== b.colorRank)
    return a.colorRank - b.colorRank
  return a.cardId < b.cardId ? -1 : a.cardId > b.cardId ? 1 : 0
}

/** 开局 / Wild 选色：剩余有色手牌数最多优先，平局按红黄绿蓝。 */
export function bestFallbackColor(hand: readonly Card[]): Color {
  let best = COLORS[0]!
  let bestCount = -1
  for (const color of COLORS) {
    const count = hand.filter(card => card.color === color).length
    if (count > bestCount) {
      best = color
      bestCount = count
    }
  }
  return best
}

/**
 * 在给定候选中选择兜底动作。
 * 候选必须与决策上下文一致；无可出候选时按阶段选抽牌 / 保留。
 */
export function chooseFallbackAction(ctx: DecisionContext, candidates: readonly Candidate[]): Candidate | null {
  if (ctx.phase === 'opening-color') {
    const color = bestFallbackColor(ctx.ownHand)
    return candidates.find(candidate => candidate.id === `opening_color_${color}`) ?? candidates[0] ?? null
  }

  const plays = candidates
    .map(candidate => rankPlayCandidate(ctx, candidate))
    .filter((rank): rank is PlayRank => rank !== null)
    .sort(comparePlays)

  if (plays.length > 0) {
    return plays[0]!.candidate
  }
  // 无可出候选：普通回合选抽牌；抽后只在没有可出候选时保留。
  const fallback = candidates.find(candidate => candidate.id === 'draw_one')
    ?? candidates.find(candidate => candidate.id === 'keep_drawn')
  return fallback ?? candidates[0] ?? null
}
