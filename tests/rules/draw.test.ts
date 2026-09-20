import type { PlayerId } from '#shared/game'
// R3：抽牌规则——有牌仍可抽、抽后出/留、不可出自动结束、禁止出旧手牌与连抽、罚抽无出牌机会
import { describe, expect, it } from 'vitest'
import { listLegalActions } from '#shared/game'
import { cardOf, makeGame, submitFail, submitOk } from './helpers'

function gameWith(p0Hand: string[], opening: string, dealerId: PlayerId = 'p3') {
  return makeGame({
    dealerId,
    openingId: opening,
    hands: {
      p0: p0Hand,
      p1: ['blue-8-2', 'blue-1-2', 'blue-2-2', 'blue-3-2', 'blue-4-2', 'blue-5-2', 'blue-6-2'],
      p2: ['green-8-2', 'green-1-2', 'green-2-2', 'green-3-2', 'green-4-2', 'green-5-2', 'green-6-2'],
      p3: ['yellow-8-2', 'yellow-1-2', 'yellow-2-2', 'yellow-3-2', 'yellow-4-2', 'yellow-5-2', 'yellow-6-2'],
    },
  })
}

/** 把指定牌移到抽牌堆末尾（下一张被抽到）。 */
function nextDrawIs(state: ReturnType<typeof makeGame>, cardId: string) {
  const pile = [...state.drawPile]
  const index = pile.indexOf(cardId)
  if (index >= 0) {
    pile.splice(index, 1)
  }
  pile.push(cardId)
  state.drawPile = pile
  return state
}

describe('抽牌（R3）', () => {
  it('有合法牌仍可抽 1 张', () => {
    const state = gameWith(
      ['red-5-2', 'red-1-2', 'red-2-2', 'red-3-2', 'red-4-2', 'red-6-2', 'red-7-2'],
      cardOf({ kind: 'number', color: 'red', value: 5 }),
    )
    // 有多张合法红牌，draw-one 仍是合法动作
    expect(listLegalActions(state, 'p0').some(a => a.type === 'draw-one')).toBe(true)
    const after = submitOk(state, 'p0', { type: 'draw-one' })
    expect(after.players.find(p => p.id === 'p0')!.hand).toHaveLength(8)
  })

  it('抽到可出牌：进入 after-draw，只能出这张或保留', () => {
    const state = nextDrawIs(
      gameWith(
        ['red-5-2', 'red-1-2', 'red-2-2', 'red-3-2', 'red-4-2', 'red-6-2', 'red-7-2'],
        cardOf({ kind: 'number', color: 'red', value: 5 }),
      ),
      'red-9-2',
    )
    const after = submitOk(state, 'p0', { type: 'draw-one' })
    expect(after.phase.kind).toBe('after-draw')
    if (after.phase.kind === 'after-draw') {
      expect(after.phase.drawnCardId).toBe('red-9-2')
    }
    expect(after.currentPlayerId).toBe('p0')
    // 合法动作只有：出这张 + keep-drawn
    const actions = listLegalActions(after, 'p0')
    expect(actions.every(a => (a.type === 'play' && a.cardId === 'red-9-2') || a.type === 'keep-drawn')).toBe(true)
    expect(actions.some(a => a.type === 'keep-drawn')).toBe(true)
    expect(actions.some(a => a.type === 'draw-one')).toBe(false)
  })

  it('抽到不可出牌：直接结束回合转下一位', () => {
    const state = nextDrawIs(
      gameWith(
        ['red-5-2', 'red-1-2', 'red-2-2', 'red-3-2', 'red-4-2', 'red-6-2', 'red-7-2'],
        cardOf({ kind: 'number', color: 'red', value: 5 }),
      ),
      'blue-9-2',
    )
    const after = submitOk(state, 'p0', { type: 'draw-one' })
    expect(after.phase.kind).toBe('turn')
    expect(after.currentPlayerId).toBe('p1')
    expect(after.players.find(p => p.id === 'p0')!.hand).toHaveLength(8)
  })

  it('after-draw：可以出刚抽到的牌；保留后转下一位', () => {
    const drawn = 'red-9-2'
    const state = nextDrawIs(
      gameWith(
        ['red-5-2', 'red-1-2', 'red-2-2', 'red-3-2', 'red-4-2', 'red-6-2', 'red-7-2'],
        cardOf({ kind: 'number', color: 'red', value: 5 }),
      ),
      drawn,
    )
    const afterDraw = submitOk(state, 'p0', { type: 'draw-one' })
    // 出刚抽到的牌
    const played = submitOk(afterDraw, 'p0', { type: 'play', cardId: drawn, declareUno: false })
    expect(played.currentPlayerId).toBe('p1')
    expect(played.discardPile[played.discardPile.length - 1]).toBe(drawn)

    // 保留：转下一位
    const kept = submitOk(afterDraw, 'p0', { type: 'keep-drawn' })
    expect(kept.currentPlayerId).toBe('p1')
    expect(kept.players.find(p => p.id === 'p0')!.hand).toHaveLength(8)
    expect(kept.recentEvents.some(e => e.type === 'kept-drawn')).toBe(true)
  })

  it('after-draw：禁止出旧手牌、禁止再抽', () => {
    const state = nextDrawIs(
      gameWith(
        ['red-5-2', 'red-1-2', 'red-2-2', 'red-3-2', 'red-4-2', 'red-6-2', 'red-7-2'],
        cardOf({ kind: 'number', color: 'red', value: 5 }),
      ),
      'red-9-2',
    )
    const afterDraw = submitOk(state, 'p0', { type: 'draw-one' })
    expect(submitFail(afterDraw, 'p0', { type: 'play', cardId: 'red-5-2', declareUno: false })).toBe('not-drawn-card')
    expect(submitFail(afterDraw, 'p0', { type: 'draw-one' })).toBe('invalid-phase')
    // 非当前玩家也不能动作
    expect(submitFail(afterDraw, 'p1', { type: 'keep-drawn' })).toBe('not-your-turn')
  })

  it('罚抽后无出牌机会：+4 受罚者被跳过', () => {
    const state = gameWith(
      ['wild-draw-four-2', 'blue-9-1', 'green-9-1', 'yellow-9-1', 'blue-8-1', 'green-8-1', 'yellow-8-1'],
      cardOf({ kind: 'number', color: 'red', value: 5 }),
    )
    const after = submitOk(state, 'p0', { type: 'play', cardId: 'wild-draw-four-2', chosenColor: 'blue', declareUno: false })
    // p1 罚抽 4 张并被跳过；阶段是 p2 的 turn（p1 无 after-draw）
    expect(after.players.find(p => p.id === 'p1')!.hand).toHaveLength(11)
    expect(after.currentPlayerId).toBe('p2')
    expect(after.phase.kind).toBe('turn')
    const drawEvent = after.recentEvents.find(e => e.type === 'cards-drawn')
    expect(drawEvent).toMatchObject({ playerId: 'p1', requested: 4, drawn: 4, reason: 'wild-draw-four' })
  })

  it('抽到 Wild 后必须选色才能出', () => {
    const state = nextDrawIs(
      gameWith(
        ['red-5-2', 'red-1-2', 'red-2-2', 'red-3-2', 'red-4-2', 'red-6-2', 'red-7-2'],
        cardOf({ kind: 'number', color: 'red', value: 5 }),
      ),
      'wild-3',
    )
    const afterDraw = submitOk(state, 'p0', { type: 'draw-one' })
    expect(afterDraw.phase.kind).toBe('after-draw')
    expect(submitFail(afterDraw, 'p0', { type: 'play', cardId: 'wild-3', declareUno: false })).toBe('invalid-chosen-color')
    const played = submitOk(afterDraw, 'p0', { type: 'play', cardId: 'wild-3', chosenColor: 'green', declareUno: false })
    expect(played.currentColor).toBe('green')
  })
})
