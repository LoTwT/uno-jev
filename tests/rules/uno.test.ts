import type { GameState, PlayerId } from '#shared/game'
// R5：UNO 宣告与抓漏——宣告、漏喊被抓罚 2、抽后出到剩 1、重新宣告、错误宣告被拒、
// AI 恒宣告、不跨回合追罚；出最后一张无需宣告
import { describe, expect, it } from 'vitest'
import { enumerateCandidatesFromState } from '#shared/game'
import { cardOf, makeGame, submitFail, submitOk } from './helpers'

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

function nextDrawIs(state: GameState, cardId: string) {
  const pile = [...state.drawPile]
  const index = pile.indexOf(cardId)
  if (index >= 0) {
    pile.splice(index, 1)
  }
  pile.push(cardId)
  state.drawPile = pile
  return state
}

/** 其他玩家抽牌让回合回到 actor（不做任何出牌 / 罚抽触发）。 */
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

/** actor 依次打出 cardsToPlay（其余玩家抽牌让回合轮转回来），把其手牌降到目标规模。 */
function reduceHand(state: GameState, actorId: PlayerId, cardsToPlay: string[]): GameState {
  let current = state
  for (const cardId of cardsToPlay) {
    current = submitOk(current, actorId, { type: 'play', cardId, declareUno: false })
    current = rotateTo(current, actorId)
  }
  return current
}

/** p0 手牌降到 2 张（红 6 / 红 7），currentColor 为红，p0 行动。 */
function p0TwoRedCards() {
  const state = gameWith(
    ['red-1-2', 'red-2-2', 'red-3-2', 'red-4-2', 'red-5-2', 'red-6-2', 'red-7-2'],
    cardOf({ kind: 'number', color: 'red', value: 9 }),
  )
  const reduced = reduceHand(state, 'p0', ['red-1-2', 'red-2-2', 'red-3-2', 'red-4-2', 'red-5-2'])
  expect(reduced.players.find(p => p.id === 'p0')!.hand).toEqual(['red-6-2', 'red-7-2'])
  expect(reduced.currentPlayerId).toBe('p0')
  expect(reduced.currentColor).toBe('red')
  return reduced
}

describe('uNO 宣告与抓漏（R5）', () => {
  it('出到剩 1 张时宣告：状态与事件生效，revision 只 +1', () => {
    const two = p0TwoRedCards()
    const declared = submitOk(two, 'p0', { type: 'play', cardId: 'red-6-2', declareUno: true })
    const p0 = declared.players.find(p => p.id === 'p0')!
    expect(p0.hand).toEqual(['red-7-2'])
    expect(p0.unoDeclared).toBe(true)
    expect(declared.revision).toBe(two.revision + 1)
    expect(declared.recentEvents.some(e => e.type === 'uno-declared' && e.playerId === 'p0')).toBe(true)
    expect(declared.recentEvents.some(e => e.type === 'uno-miss-caught')).toBe(false)
  })

  it('漏喊：当前方向下一位 AI 抓漏，罚抽 2 在同一动作内结算，revision 只 +1', () => {
    const two = p0TwoRedCards()
    const missed = submitOk(two, 'p0', { type: 'play', cardId: 'red-6-2', declareUno: false })
    const catchEvent = missed.recentEvents.find(e => e.type === 'uno-miss-caught')
    expect(catchEvent).toMatchObject({ playerId: 'p0', caughtBy: 'p1', penaltyCount: 2 })
    // 同一动作内罚抽 2 张（手牌 1 + 2 = 3）
    expect(missed.players.find(p => p.id === 'p0')!.hand).toHaveLength(3)
    const drawEvent = missed.recentEvents.find(e => e.type === 'cards-drawn' && e.reason === 'uno-miss')
    expect(drawEvent).toMatchObject({ playerId: 'p0', requested: 2, drawn: 2 })
    expect(missed.revision).toBe(two.revision + 1)
    expect(missed.players.find(p => p.id === 'p0')!.unoDeclared).toBe(false)
  })

  it('reverse 方向翻转后，抓漏者是新方向的下一位 AI', () => {
    const state = gameWith(
      ['red-1-2', 'red-2-2', 'red-3-2', 'red-4-2', 'red-5-2', 'red-reverse-2', 'red-7-2'],
      cardOf({ kind: 'number', color: 'red', value: 9 }),
    )
    const reduced = reduceHand(state, 'p0', ['red-1-2', 'red-2-2', 'red-3-2', 'red-4-2', 'red-5-2'])
    const missed = submitOk(reduced, 'p0', { type: 'play', cardId: 'red-reverse-2', declareUno: false })
    expect(missed.direction).toBe(-1)
    // 新方向下一位 AI 是 p3
    expect(missed.recentEvents.find(e => e.type === 'uno-miss-caught')).toMatchObject({ playerId: 'p0', caughtBy: 'p3' })
  })

  it('抽牌重新持牌 >1 后清除宣告；再出到剩 1 需重新宣告（再漏再被抓）', () => {
    const two = p0TwoRedCards()
    const declared = submitOk(two, 'p0', { type: 'play', cardId: 'red-6-2', declareUno: true })
    expect(declared.players.find(p => p.id === 'p0')!.unoDeclared).toBe(true)
    // 轮回 p0 后抽 1 张红牌
    let current = rotateTo(declared, 'p0')
    current = submitOk(nextDrawIs(current, 'red-9-1'), 'p0', { type: 'draw-one' })
    expect(current.players.find(p => p.id === 'p0')!.hand).toEqual(['red-7-2', 'red-9-1'])
    expect(current.players.find(p => p.id === 'p0')!.unoDeclared).toBe(false)
    // after-draw：出这张不再宣告 → 再次被抓
    expect(current.phase.kind).toBe('after-draw')
    const missedAgain = submitOk(current, 'p0', { type: 'play', cardId: 'red-9-1', declareUno: false })
    expect(missedAgain.recentEvents.find(e => e.type === 'uno-miss-caught')).toMatchObject({ playerId: 'p0', penaltyCount: 2 })
  })

  it('手牌数量不是 2 时携带 declareUno: true 被拒（7 张 / 打到 3 张）', () => {
    const state = gameWith(
      ['red-5-2', 'red-1-2', 'red-2-2', 'red-3-2', 'red-4-2', 'red-6-2', 'red-7-2'],
      cardOf({ kind: 'number', color: 'red', value: 9 }),
    )
    // 7 张手牌
    expect(submitFail(state, 'p0', { type: 'play', cardId: 'red-5-2', declareUno: true })).toBe('invalid-uno-declaration')
    // 打到 3 张
    const reduced = reduceHand(state, 'p0', ['red-5-2', 'red-1-2', 'red-2-2', 'red-3-2'])
    expect(reduced.players.find(p => p.id === 'p0')!.hand).toHaveLength(3)
    expect(submitFail(reduced, 'p0', { type: 'play', cardId: 'red-4-2', declareUno: true })).toBe('invalid-uno-declaration')
  })

  it('手牌 1 张（赢局出牌）携带 declareUno: true 被拒；不宣告直接获胜', () => {
    const two = p0TwoRedCards()
    const oneLeft = submitOk(two, 'p0', { type: 'play', cardId: 'red-6-2', declareUno: true })
    // p0 剩 1 张，轮转回来
    const back = rotateTo(oneLeft, 'p0')
    expect(back.players.find(p => p.id === 'p0')!.hand).toEqual(['red-7-2'])
    expect(submitFail(back, 'p0', { type: 'play', cardId: 'red-7-2', declareUno: true })).toBe('invalid-uno-declaration')
    const won = submitOk(back, 'p0', { type: 'play', cardId: 'red-7-2', declareUno: false })
    expect(won.phase.kind).toBe('finished')
    if (won.phase.kind === 'finished') {
      expect(won.phase.result).toEqual({ reason: 'empty-hand', winnerId: 'p0' })
    }
  })

  it('aI 候选仅在出后剩 1 张时 declareUno 为 true', () => {
    // p1 降到 2 张蓝牌（dealer p0 → 左侧 p1 先手；起始蓝 9）
    const state = makeGame({
      dealerId: 'p0',
      openingId: cardOf({ kind: 'number', color: 'blue', value: 9 }),
      hands: {
        p0: ['red-1-2', 'red-2-2', 'red-3-2', 'red-4-2', 'red-5-2', 'red-6-2', 'red-7-2'],
        p1: ['blue-1-2', 'blue-2-2', 'blue-3-2', 'blue-4-2', 'blue-5-2', 'blue-6-2', 'blue-7-2'],
        p2: ['green-1-2', 'green-2-2', 'green-3-2', 'green-4-2', 'green-5-2', 'green-6-2', 'green-7-2'],
        p3: ['yellow-1-2', 'yellow-2-2', 'yellow-3-2', 'yellow-4-2', 'yellow-5-2', 'yellow-6-2', 'yellow-7-2'],
      },
    })
    expect(state.currentPlayerId).toBe('p1')
    const reduced = reduceHand(state, 'p1', ['blue-1-2', 'blue-2-2', 'blue-3-2', 'blue-4-2', 'blue-5-2'])
    expect(reduced.players.find(p => p.id === 'p1')!.hand).toEqual(['blue-6-2', 'blue-7-2'])
    expect(reduced.currentPlayerId).toBe('p1')
    const candidates = enumerateCandidatesFromState(reduced)!.filter(c => c.action.type === 'play')
    expect(candidates.length).toBeGreaterThan(0)
    for (const candidate of candidates) {
      if (candidate.action.type === 'play') {
        expect(candidate.action.declareUno, `候选 ${candidate.id}`).toBe(true)
      }
    }
    // 手牌更多（7 张）时恒 false
    const freshCandidates = enumerateCandidatesFromState(state)!.filter(c => c.action.type === 'play')
    for (const candidate of freshCandidates) {
      if (candidate.action.type === 'play') {
        expect(candidate.action.declareUno).toBe(false)
      }
    }
  })

  it('漏喊结算后不跨回合追罚', () => {
    const two = p0TwoRedCards()
    const missed = submitOk(two, 'p0', { type: 'play', cardId: 'red-6-2', declareUno: false })
    const before = missed.recentEvents.filter(e => e.type === 'uno-miss-caught').length
    expect(before).toBe(1)
    // 后续多步正常轮转（全部抽牌），不再出现新的抓漏
    let current = missed
    for (let step = 0; step < 12 && current.phase.kind !== 'finished'; step++) {
      const who = current.currentPlayerId
      current = submitOk(current, who, { type: 'draw-one' })
      if (current.phase.kind === 'after-draw') {
        current = submitOk(current, who, { type: 'keep-drawn' })
      }
    }
    expect(current.recentEvents.filter(e => e.type === 'uno-miss-caught').length).toBe(1)
  })
})
