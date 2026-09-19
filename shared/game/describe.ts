import type { Candidate } from './candidates'
import type { DecisionContext } from './decision'
import type { Color } from './types'
/**
 * AI 候选的英文描述，用于 TypeSafe Choice 的 criteria。
 * 描述包括牌面、选色、宣告及确定的规则效果；
 * 指令与描述固定为英文，与中文 UI 分开维护（规格：TypeSafe 适配）。
 */
import { cardNameEn, getCard } from './cards'

const COLOR_EN: Record<Color, string> = {
  red: 'red',
  yellow: 'yellow',
  green: 'green',
  blue: 'blue',
}

/** choose_action 问题的固定英文指令；不让模型制定规则或假定知道暗牌。 */
export const CHOOSE_ACTION_INSTRUCTIONS
  = 'Based only on the visible information, choose exactly one candidate action from the options. '
    + 'Your goal is to be the first player to run out of cards. '
    + 'You may not invent rules, assume knowledge of hidden cards, or choose an option that is not listed.'

function cardsLeftPhrase(ctx: DecisionContext): string {
  const left = ctx.ownHand.length - 1
  if (left === 0) {
    return 'This is your last card; you win the round.'
  }
  return `You will have ${left} card${left === 1 ? '' : 's'} left in hand.`
}

function handColorCounts(ctx: DecisionContext): string {
  const counts = ctx.ownHand.filter(card => card.color !== null).length
  return counts.toString()
}

/**
 * 生成候选的规则效果描述。
 * 只描述由规则确定的直接效果，不虚构对手反应或胜率。
 */
export function describeCandidate(ctx: DecisionContext, candidate: Candidate): string {
  const action = candidate.action
  switch (action.type) {
    case 'choose-opening-color': {
      const keeping = ctx.ownHand.filter(card => card.color === action.color).length
      return `Choose ${COLOR_EN[action.color]} as the opening color. The discard pile then matches ${COLOR_EN[action.color]}, and it becomes your normal turn. You keep ${keeping} ${COLOR_EN[action.color]} card${keeping === 1 ? '' : 's'} in hand (${handColorCounts(ctx)} colored cards in total).`
    }
    case 'draw-one': {
      return `Draw one card from the draw pile (${ctx.topCard ? `the pile currently holds cards hidden from you` : ''}). If the drawn card is playable you may immediately play only that card; otherwise your turn ends. You cannot play the cards already in your hand after drawing.`
    }
    case 'keep-drawn': {
      return `Keep the drawn card ${ctx.drawnCardId ? `(${cardNameEn(getCard(ctx.drawnCardId)!)})` : ''} in your hand and end your turn without playing.`
    }
    case 'play': {
      const card = getCard(action.cardId)
      if (!card) {
        return 'Unknown candidate.'
      }
      const name = cardNameEn(card)
      const parts: string[] = []
      parts.push(`Play ${name}.`)
      // 匹配依据
      if (card.color !== null) {
        if (ctx.currentColor === card.color) {
          parts.push(`It matches the current color (${COLOR_EN[ctx.currentColor]}).`)
        }
        else {
          parts.push(`It matches the top card's ${card.kind === 'number' ? `number ${card.value}` : 'symbol'}.`)
        }
      }
      else if (action.chosenColor) {
        parts.push(`It is a wild card; you choose ${COLOR_EN[action.chosenColor]} as the new current color.`)
      }
      // 确定效果
      switch (card.kind) {
        case 'skip':
          parts.push('The next player is skipped.')
          break
        case 'reverse':
          parts.push('The direction of play reverses.')
          break
        case 'draw-two':
          parts.push('The next player draws 2 cards and is skipped.')
          break
        case 'wild-draw-four':
          parts.push('The next player draws 4 cards and is skipped.')
          break
      }
      parts.push(cardsLeftPhrase(ctx))
      if (action.declareUno) {
        parts.push('You declare UNO with this play.')
      }
      return parts.join(' ')
    }
  }
}
