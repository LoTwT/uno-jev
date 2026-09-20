import type { GameState, PlayerId } from '#shared/game'
// R6：末张牌各类结算、最后 +2/+4 先罚抽后结束、胜者唯一、结束后无动作、无 500 分累计
import { describe, expect, it } from 'vitest'
import { listLegalActions } from '#shared/game'
import { cardOf, makeGame, submit, submitOk } from './helpers'

function gameWith(p0Hand: string[], opening: string, dealerId: PlayerId = 'p3') {
  return makeGame({
    dealerId,
    openingId: opening,
    hands: {
      p0: p0Hand,
      p1: ['blue-1-2', 'blue-2-2', 'blue-3-2', 'blue-4-2', 'blue-5-2', 'blue-6-2', 'blue-7-2'],
      p2: ['green-1-2', 'green-2-2', 'green-3-2', 'green-4-2', 'green-5-2', 'green-6-2', 'green-7-2'],
      p3: ['yellow-1-2', 'yellow-2-2', 'yellow-3-2', 'yellow-4-2', 'yellow-5-2', 'yellow-6-2', 'yellow-7-2'],
    },
  })
}

function rotateTo(state: GameState, actorId: PlayerId): GameState {
  let current = state
  for (let guard = 0; guard < 8; guard++) {
    if (current.phase.kind === 'finished' || current.currentPlayerId === actorId) {
      return current
    }
    const who = current.currentPlayerId
    current = submitOk(current, who, { type: 'draw-one' })
    if (current.phase.kind === 'after-draw') {
      current = submitOk(current, who, { type: 'keep-drawn' })
    }
  }
  return current
}

function reduceHand(state: GameState, actorId: PlayerId, cardsToPlay: string[]): GameState {
  let current = state
  for (const cardId of cardsToPlay) {
    // 降到剩 1 张的那次出牌自动宣告，避免触发 AI 抓漏罚抽
    const handLength = current.players.find(p => p.id === actorId)!.hand.length
    current = submitOk(current, actorId, { type: 'play', cardId, declareUno: handLength === 2 })
    current = rotateTo(current, actorId)
  }
  return current
}

/** p0 打到只剩 lastCard 一张且轮到 p0。 */
function p0LastCard(lastCard: string, fillers: string[], opening: string) {
  const state = gameWith([...fillers, lastCard], opening)
  const reduced = reduceHand(state, 'p0', fillers)
  expect(reduced.players.find(p => p.id === 'p0')!.hand).toEqual([lastCard])
  expect(reduced.currentPlayerId).toBe('p0')
  return reduced
}

describe('末张牌结算（R6）', () => {
  const cases: Array<[string, string, string[], string]> = [
    ['数字牌', 'red-8-1', ['red-1-2', 'red-2-2', 'red-3-2', 'red-4-2', 'red-5-2', 'red-6-2'], cardOf({ kind: 'number', color: 'red', value: 9 })],
    ['Skip', 'red-skip-2', ['red-1-2', 'red-2-2', 'red-3-2', 'red-4-2', 'red-5-2', 'red-6-2'], cardOf({ kind: 'number', color: 'red', value: 9 })],
    ['Reverse', 'red-reverse-2', ['red-1-2', 'red-2-2', 'red-3-2', 'red-4-2', 'red-5-2', 'red-6-2'], cardOf({ kind: 'number', color: 'red', value: 9 })],
    ['Draw Two', 'red-draw-two-2', ['red-1-2', 'red-2-2', 'red-3-2', 'red-4-2', 'red-5-2', 'red-6-2'], cardOf({ kind: 'number', color: 'red', value: 9 })],
    ['Wild', 'wild-2', ['red-1-2', 'red-2-2', 'red-3-2', 'red-4-2', 'red-5-2', 'red-6-2'], cardOf({ kind: 'number', color: 'red', value: 9 })],
  ]

  for (const [name, lastCard, fillers, opening] of cases) {
    it(`${name} 作为末张牌：出完获胜`, () => {
      const state = p0LastCard(lastCard, fillers, opening)
      const action = lastCard.startsWith('wild')
        ? { type: 'play', cardId: lastCard, chosenColor: 'red', declareUno: false } as const
        : { type: 'play', cardId: lastCard, declareUno: false } as const
      const won = submitOk(state, 'p0', action)
      expect(won.phase.kind).toBe('finished')
      if (won.phase.kind === 'finished') {
        expect(won.phase.result).toEqual({ reason: 'empty-hand', winnerId: 'p0' })
      }
      expect(won.players.find(p => p.id === 'p0')!.hand).toHaveLength(0)
      expect(won.recentEvents.some(e => e.type === 'game-finished')).toBe(true)
    })
  }

  it('末张 +4：受罚下一位先完成罚抽再结束（合法 +4 无同色手牌）', () => {
    // p0 手牌全是蓝，最后一张是 +4；p1 换用不冲突的手牌
    const fillers = ['blue-1-2', 'blue-2-2', 'blue-3-2', 'blue-4-2', 'blue-5-2', 'blue-6-2']
    const state = makeGame({
      dealerId: 'p3',
      openingId: cardOf({ kind: 'number', color: 'blue', value: 9 }),
      hands: {
        p0: [...fillers, 'wild-draw-four-2'],
        p1: ['yellow-8-1', 'yellow-8-2', 'yellow-9-1', 'yellow-9-2', 'red-9-1', 'red-9-2', 'green-9-1'],
        p2: ['green-1-2', 'green-2-2', 'green-3-2', 'green-4-2', 'green-5-2', 'green-6-2', 'green-7-2'],
        p3: ['yellow-1-2', 'yellow-2-2', 'yellow-3-2', 'yellow-4-2', 'yellow-5-2', 'yellow-6-2', 'yellow-7-2'],
      },
    })
    const reduced = reduceHand(state, 'p0', fillers)
    expect(reduced.players.find(p => p.id === 'p0')!.hand).toEqual(['wild-draw-four-2'])
    expect(reduced.currentPlayerId).toBe('p0')
    const p1Before = reduced.players.find(p => p.id === 'p1')!.hand.length
    const won = submitOk(reduced, 'p0', { type: 'play', cardId: 'wild-draw-four-2', chosenColor: 'blue', declareUno: false })
    expect(won.phase.kind).toBe('finished')
    // p1 先罚抽 4 张再进入结束状态
    expect(won.players.find(p => p.id === 'p1')!.hand).toHaveLength(p1Before + 4)
    const drawEvent = won.recentEvents.find(e => e.type === 'cards-drawn' && e.reason === 'wild-draw-four')
    expect(drawEvent).toMatchObject({ playerId: 'p1', requested: 4, drawn: 4 })
    expect(won.recentEvents.some(e => e.type === 'player-skipped' && e.playerId === 'p1')).toBe(true)
  })

  it('末张 +2：受罚下一位先罚抽 2 再结束', () => {
    const fillers = ['red-1-2', 'red-2-2', 'red-3-2', 'red-4-2', 'red-5-2', 'red-6-2']
    const state = p0LastCard('red-draw-two-2', fillers, cardOf({ kind: 'number', color: 'red', value: 9 }))
    const p1Before = state.players.find(p => p.id === 'p1')!.hand.length
    const won = submitOk(state, 'p0', { type: 'play', cardId: 'red-draw-two-2', declareUno: false })
    expect(won.phase.kind).toBe('finished')
    expect(won.players.find(p => p.id === 'p1')!.hand).toHaveLength(p1Before + 2)
    expect(won.recentEvents.find(e => e.type === 'cards-drawn' && e.reason === 'draw-two')).toMatchObject({ playerId: 'p1', requested: 2, drawn: 2 })
  })

  it('末张 Reverse 仍更新方向；末张 Skip 仍记录跳过', () => {
    const fillers = ['red-1-2', 'red-2-2', 'red-3-2', 'red-4-2', 'red-5-2', 'red-6-2']
    const reverseState = p0LastCard('red-reverse-2', fillers, cardOf({ kind: 'number', color: 'red', value: 9 }))
    const afterReverse = submitOk(reverseState, 'p0', { type: 'play', cardId: 'red-reverse-2', declareUno: false })
    expect(afterReverse.direction).toBe(-1)
    expect(afterReverse.phase.kind).toBe('finished')

    const skipState = p0LastCard('red-skip-2', fillers, cardOf({ kind: 'number', color: 'red', value: 9 }))
    const afterSkip = submitOk(skipState, 'p0', { type: 'play', cardId: 'red-skip-2', declareUno: false })
    expect(afterSkip.recentEvents.some(e => e.type === 'player-skipped' && e.playerId === 'p1' && e.reason === 'skip')).toBe(true)
    expect(afterSkip.phase.kind).toBe('finished')
  })

  it('空手胜者唯一；结束后无任何动作；无 500 分累计', () => {
    const fillers = ['red-1-2', 'red-2-2', 'red-3-2', 'red-4-2', 'red-5-2', 'red-6-2']
    const state = p0LastCard('red-8-1', fillers, cardOf({ kind: 'number', color: 'red', value: 9 }))
    const won = submitOk(state, 'p0', { type: 'play', cardId: 'red-8-1', declareUno: false })
    // 恰好一位空手
    expect(won.players.filter(p => p.hand.length === 0)).toHaveLength(1)
    // 结束后没有任何合法动作
    for (const player of won.players) {
      expect(listLegalActions(won, player.id)).toEqual([])
    }
    for (const player of won.players) {
      const result = submit(won, player.id, { type: 'draw-one' })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toBe('invalid-phase')
      }
    }
    // 结束结果不含计分字段
    if (won.phase.kind === 'finished') {
      expect(Object.keys(won.phase.result).sort()).toEqual(['reason', 'winnerId'])
      expect(won.phase.result.reason === 'empty-hand' || won.phase.result.reason === 'blocked').toBe(true)
    }
  })
})
