import type { PlayerId } from '#shared/game'
// R2：同色/同数/同符号/Wild 匹配合法性；双向跨 p3↔p0 回合切换；Skip、Reverse、+2 罚抽与跳过
import { describe, expect, it } from 'vitest'
import { applyAction } from '#shared/game'
import { cardOf, makeGame, submit, submitFail, submitOk, topCardOf } from './helpers'

/** 常用构造：p0 先手、起始数字牌决定颜色；p1/p2/p3 拿固定安全手牌（-2 副本 1..7）。 */
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

/** 抽 1 张后若可出则保留，确保回合转交下一位。 */
function passTurn(state: ReturnType<typeof makeGame>, playerId: PlayerId): ReturnType<typeof submitOk> {
  let next = submitOk(state, playerId, { type: 'draw-one' })
  if (next.phase.kind === 'after-draw') {
    next = submitOk(next, playerId, { type: 'keep-drawn' })
  }
  return next
}

describe('出牌合法性与匹配（R2）', () => {
  it('同色可出；同数字异色可出；同功能符号异色可出；都不匹配不可出', () => {
    const state = gameWith(
      ['red-5-2', 'blue-5-1', 'blue-skip-2', 'yellow-8-1', 'red-1-2', 'red-2-2', 'red-3-2'],
      cardOf({ kind: 'number', color: 'red', value: 5 }),
    )
    expect(topCardOf(state).id).toBe(cardOf({ kind: 'number', color: 'red', value: 5 }))
    submitOk(state, 'p0', { type: 'play', cardId: 'red-1-2', declareUno: false }) // 同色
    submitOk(state, 'p0', { type: 'play', cardId: 'blue-5-1', declareUno: false }) // 同数字异色
    expect(submitFail(state, 'p0', { type: 'play', cardId: 'yellow-8-1', declareUno: false })).toBe('card-not-playable')
    // 起始 Skip：dealer p2 → 左侧 p3 被跳过，p0 先行动，顶牌为绿 Skip
    const state2 = gameWith(
      ['blue-skip-2', 'red-5-2', 'yellow-8-1', 'red-1-2', 'red-2-2', 'red-3-2', 'red-4-2'],
      cardOf({ kind: 'skip', color: 'green' }),
      'p2',
    )
    submitOk(state2, 'p0', { type: 'play', cardId: 'blue-skip-2', declareUno: false })
    expect(submitFail(state2, 'p0', { type: 'play', cardId: 'yellow-8-1', declareUno: false })).toBe('card-not-playable')
  })

  it('顶牌为 Wild 时以 currentColor 为颜色依据', () => {
    const state = makeGame({
      dealerId: 'p2',
      openingId: cardOf({ kind: 'number', color: 'green', value: 1 }),
      hands: {
        p0: ['red-5-2', 'green-5-1', 'red-1-2', 'red-2-2', 'red-3-2', 'red-4-2', 'blue-9-2'],
        p1: ['blue-1-2', 'blue-2-2', 'blue-3-2', 'blue-4-2', 'blue-5-2', 'blue-6-2', 'blue-7-2'],
        p2: ['green-1-2', 'green-2-2', 'green-3-2', 'green-4-2', 'green-5-2', 'green-6-2', 'green-7-2'],
        p3: ['wild-2', 'yellow-1-2', 'yellow-2-2', 'yellow-3-2', 'yellow-4-2', 'yellow-5-2', 'yellow-6-2'],
      },
    })
    const afterWild = submitOk(state, 'p3', { type: 'play', cardId: 'wild-2', chosenColor: 'red', declareUno: false })
    expect(afterWild.currentColor).toBe('red')
    expect(submitFail(afterWild, 'p0', { type: 'play', cardId: 'green-5-1', declareUno: false })).toBe('card-not-playable')
    submitOk(afterWild, 'p0', { type: 'play', cardId: 'red-5-2', declareUno: false })
  })

  it('有色牌携带 chosenColor 被拒；Wild 不带 chosenColor 被拒', () => {
    const state = gameWith(
      ['red-5-2', 'wild-2', 'red-1-2', 'red-2-2', 'red-3-2', 'red-4-2', 'blue-9-1'],
      cardOf({ kind: 'number', color: 'red', value: 5 }),
    )
    expect(submitFail(state, 'p0', { type: 'play', cardId: 'red-5-2', chosenColor: 'blue', declareUno: false })).toBe('invalid-chosen-color')
    expect(submitFail(state, 'p0', { type: 'play', cardId: 'wild-2', declareUno: false })).toBe('invalid-chosen-color')
  })

  it('出他人手牌 / 不存在的牌被拒', () => {
    const state = gameWith(
      ['red-5-2', 'red-1-2', 'red-2-2', 'red-3-2', 'red-4-2', 'red-6-2', 'red-7-2'],
      cardOf({ kind: 'number', color: 'red', value: 5 }),
    )
    expect(submitFail(state, 'p0', { type: 'play', cardId: 'blue-1-2', declareUno: false })).toBe('card-not-in-hand')
    expect(submitFail(state, 'p0', { type: 'play', cardId: 'nonexistent', declareUno: false })).toBe('card-not-in-hand')
  })
})

describe('回合切换（R2）', () => {
  it('direction=1 沿数组前进，p3 之后回到 p0', () => {
    const state = gameWith(
      ['red-5-2', 'red-1-2', 'red-2-2', 'red-3-2', 'red-4-2', 'red-6-2', 'red-7-2'],
      cardOf({ kind: 'number', color: 'red', value: 5 }),
      'p2',
    )
    expect(state.currentPlayerId).toBe('p3')
    const afterP3 = passTurn(state, 'p3')
    expect(afterP3.currentPlayerId).toBe('p0')
    const afterP0 = submitOk(afterP3, 'p0', { type: 'play', cardId: 'red-5-2', declareUno: false })
    expect(afterP0.currentPlayerId).toBe('p1')
  })

  it('direction=-1 时 p0 之后轮到 p3（跨 p0↔p3 反向）', () => {
    const state = makeGame({
      dealerId: 'p1',
      openingId: cardOf({ kind: 'reverse', color: 'red' }),
      hands: {
        p0: ['red-5-2', 'red-1-2', 'red-2-2', 'red-3-2', 'red-4-2', 'red-6-2', 'red-7-2'],
        p1: ['blue-1-2', 'blue-2-2', 'blue-3-2', 'blue-4-2', 'blue-5-2', 'blue-6-2', 'blue-7-2'],
        p2: ['green-1-2', 'green-2-2', 'green-3-2', 'green-4-2', 'green-5-2', 'green-6-2', 'green-7-2'],
        p3: ['yellow-1-2', 'yellow-2-2', 'yellow-3-2', 'yellow-4-2', 'yellow-5-2', 'yellow-6-2', 'yellow-7-2'],
      },
    })
    expect(state.direction).toBe(-1)
    expect(state.currentPlayerId).toBe('p1')
    const afterP1 = passTurn(state, 'p1')
    expect(afterP1.currentPlayerId).toBe('p0')
    const afterP0 = submitOk(afterP1, 'p0', { type: 'play', cardId: 'red-5-2', declareUno: false })
    expect(afterP0.currentPlayerId).toBe('p3')
  })

  it('skip 跳过一次：下一位被跳过，再下一位行动', () => {
    const state = gameWith(
      ['green-skip-2', 'green-1-1', 'green-2-1', 'green-3-1', 'green-4-1', 'green-6-1', 'green-7-1'],
      cardOf({ kind: 'number', color: 'green', value: 5 }),
    )
    const after = submitOk(state, 'p0', { type: 'play', cardId: 'green-skip-2', declareUno: false })
    expect(after.currentPlayerId).toBe('p2')
    const skipEvent = after.recentEvents.find(e => e.type === 'player-skipped')
    expect(skipEvent).toMatchObject({ playerId: 'p1', reason: 'skip' })
  })

  it('四人 Reverse 翻向不当 Skip：下一位是反方向邻座', () => {
    const state = gameWith(
      ['red-reverse-2', 'red-1-2', 'red-2-2', 'red-3-2', 'red-4-2', 'red-6-2', 'red-7-2'],
      cardOf({ kind: 'number', color: 'red', value: 5 }),
    )
    const after = submitOk(state, 'p0', { type: 'play', cardId: 'red-reverse-2', declareUno: false })
    expect(after.direction).toBe(-1)
    expect(after.currentPlayerId).toBe('p3')
    const reverseEvent = after.recentEvents.find(e => e.type === 'direction-reversed')
    expect(reverseEvent).toMatchObject({ byPlayerId: 'p0' })
    expect(after.recentEvents.some(e => e.type === 'player-skipped')).toBe(false)
  })

  it('+2：下一位抽 2 并被跳过，无出牌机会，不可叠加', () => {
    const state = gameWith(
      ['red-draw-two-2', 'red-1-2', 'red-2-2', 'red-3-2', 'red-4-2', 'red-6-2', 'red-7-2'],
      cardOf({ kind: 'number', color: 'red', value: 5 }),
    )
    const before = state.players.find(p => p.id === 'p1')!.hand.length
    const after = submitOk(state, 'p0', { type: 'play', cardId: 'red-draw-two-2', declareUno: false })
    expect(after.players.find(p => p.id === 'p1')!.hand.length).toBe(before + 2)
    expect(after.currentPlayerId).toBe('p2')
    expect(after.phase.kind).toBe('turn')
    const drawEvent = after.recentEvents.find(e => e.type === 'cards-drawn')
    expect(drawEvent).toMatchObject({ playerId: 'p1', requested: 2, drawn: 2, reason: 'draw-two' })
    expect(after.currentPlayerId).not.toBe('p1')
    const plusTwoInP1Hand = after.players.find(p => p.id === 'p1')!.hand.find(id => id.includes('draw-two'))
    if (plusTwoInP1Hand) {
      expect(submitFail(after, 'p1', { type: 'play', cardId: plusTwoInP1Hand, declareUno: false })).toBe('not-your-turn')
    }
    else {
      const anyCard = after.players.find(p => p.id === 'p1')!.hand[0]!
      expect(submitFail(after, 'p1', { type: 'play', cardId: anyCard, declareUno: false })).toBe('not-your-turn')
    }
  })

  it('revision 与 gameId 校验：过期提交与错局提交被拒', () => {
    const state = gameWith(
      ['red-5-2', 'red-1-2', 'red-2-2', 'red-3-2', 'red-4-2', 'red-6-2', 'red-7-2'],
      cardOf({ kind: 'number', color: 'red', value: 5 }),
    )
    const first = submit(state, 'p0', { type: 'play', cardId: 'red-5-2', declareUno: false })
    expect(first.ok).toBe(true)
    if (!first.ok) {
      return
    }
    const stale = applyAction(first.state, {
      actorId: 'p1',
      gameId: first.state.gameId,
      expectedRevision: 0,
      action: { type: 'draw-one' },
    })
    expect(stale.ok).toBe(false)
    if (!stale.ok) {
      expect(stale.error).toBe('stale-revision')
    }
    const wrongGame = applyAction(first.state, {
      actorId: 'p1',
      gameId: '99999999-9999-4999-8999-999999999999',
      expectedRevision: 1,
      action: { type: 'draw-one' },
    })
    expect(wrongGame.ok).toBe(false)
    if (!wrongGame.ok) {
      expect(wrongGame.error).toBe('game-id-mismatch')
    }
  })
})
