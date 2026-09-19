import type { GameState, PlayerId } from '#shared/game'
// S1：各可持久阶段往返序列化后完全一致；刷新不重复抽牌或结算
import { describe, expect, it } from 'vitest'
import { listLegalActions, validateState } from '#shared/game'
import { cardOf, makeGame, submitOk } from '../rules/helpers'

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

function roundtrip(state: GameState): GameState {
  const revived = JSON.parse(JSON.stringify(state)) as GameState
  expect(validateState(revived).ok, '往返后状态合法').toBe(true)
  return revived
}

function assertSameGame(a: GameState, b: GameState) {
  expect(b.gameId).toBe(a.gameId)
  expect(b.revision).toBe(a.revision)
  expect(b.currentColor).toBe(a.currentColor)
  expect(b.direction).toBe(a.direction)
  expect(b.currentPlayerId).toBe(a.currentPlayerId)
  expect(b.phase).toEqual(a.phase)
  expect(b.blockedTurnCount).toBe(a.blockedTurnCount)
  expect(b.drawPile).toEqual(a.drawPile)
  expect(b.discardPile).toEqual(a.discardPile)
  expect(b.players.map(p => p.hand)).toEqual(a.players.map(p => p.hand))
  expect(b.players.map(p => p.unoDeclared)).toEqual(a.players.map(p => p.unoDeclared))
  expect(listLegalActions(b, 'p0')).toEqual(listLegalActions(a, 'p0'))
  expect(listLegalActions(b, 'p1')).toEqual(listLegalActions(a, 'p1'))
}

describe('存档往返（S1）', () => {
  it('turn 阶段往返：牌堆顺序、手牌、合法动作完全一致', () => {
    const state = gameWith(
      ['red-5-2', 'red-1-2', 'blue-9-1', 'green-9-1', 'yellow-9-1', 'blue-8-1', 'green-8-1'],
      cardOf({ kind: 'number', color: 'red', value: 5 }),
    )
    assertSameGame(state, roundtrip(state))
  })

  it('opening-color 阶段往返：恢复到原决策点', () => {
    const state = gameWith(
      ['red-5-2', 'red-1-2', 'blue-9-1', 'green-9-1', 'yellow-9-1', 'blue-8-1', 'green-8-1'],
      'wild-1',
    )
    expect(state.phase.kind).toBe('opening-color')
    assertSameGame(state, roundtrip(state))
  })

  it('after-draw 阶段往返：drawnCardId 不变，刷新不重复抽牌', () => {
    const state = gameWith(
      ['red-5-2', 'red-1-2', 'blue-9-1', 'green-9-1', 'yellow-9-1', 'blue-8-1', 'green-8-1'],
      cardOf({ kind: 'number', color: 'red', value: 5 }),
    )
    // p0 抽到可出牌 red-9-2
    const pile = [...state.drawPile]
    pile.splice(pile.indexOf('red-9-2'), 1)
    pile.push('red-9-2')
    state.drawPile = pile
    const afterDraw = submitOk(state, 'p0', { type: 'draw-one' })
    expect(afterDraw.phase.kind).toBe('after-draw')

    const revived = roundtrip(afterDraw)
    if (revived.phase.kind === 'after-draw') {
      expect(revived.phase.drawnCardId).toBe('red-9-2')
    }
    assertSameGame(afterDraw, revived)
    // 对往返后状态与原状态分别执行 keep-drawn：结果一致（不重复抽牌 / 结算）
    const keptOriginal = submitOk(afterDraw, 'p0', { type: 'keep-drawn' })
    const keptRevived = submitOk(revived, 'p0', { type: 'keep-drawn' })
    expect(keptRevived.revision).toBe(keptOriginal.revision)
    expect(keptRevived.currentPlayerId).toBe(keptOriginal.currentPlayerId)
    expect(keptRevived.players.map(p => p.hand)).toEqual(keptOriginal.players.map(p => p.hand))
  })

  it('finished（empty-hand）阶段往返', () => {
    const state = gameWith(
      ['red-1-2', 'red-2-2', 'red-3-2', 'red-4-2', 'red-5-2', 'red-6-2', 'red-7-2'],
      cardOf({ kind: 'number', color: 'red', value: 9 }),
    )
    // 降到 1 张后赢局
    let current = state
    for (const cardId of ['red-1-2', 'red-2-2', 'red-3-2', 'red-4-2', 'red-5-2', 'red-6-2']) {
      const handLength = current.players.find(p => p.id === 'p0')!.hand.length
      current = submitOk(current, 'p0', { type: 'play', cardId, declareUno: handLength === 2 })
      current = rotateTo(current, 'p0')
    }
    const won = submitOk(current, 'p0', { type: 'play', cardId: 'red-7-2', declareUno: false })
    expect(won.phase.kind).toBe('finished')
    assertSameGame(won, roundtrip(won))
  })

  it('finished（blocked 和局）阶段往返', () => {
    // 通过随机游走找一个 blocked 结束的种子
    let found: GameState | null = null
    for (let seed = 1; seed < 60 && !found; seed++) {
      let s = makeGame({
        dealerId: 'p3',
        openingId: cardOf({ kind: 'number', color: 'red', value: 5 }),
        hands: {
          p0: ['red-5-2', 'red-1-2', 'blue-9-1', 'green-9-1', 'yellow-9-1', 'blue-8-1', 'green-8-1'],
          p1: ['blue-1-2', 'blue-2-2', 'blue-3-2', 'blue-4-2', 'blue-5-2', 'blue-6-2', 'blue-7-2'],
          p2: ['green-1-2', 'green-2-2', 'green-3-2', 'green-4-2', 'green-5-2', 'green-6-2', 'green-7-2'],
          p3: ['yellow-1-2', 'yellow-2-2', 'yellow-3-2', 'yellow-4-2', 'yellow-5-2', 'yellow-6-2', 'yellow-7-2'],
        },
      })
      // 强制和局：所有人持续抽牌（抽空后 0 抽累计）
      let guard = 0
      while (s.phase.kind !== 'finished' && guard < 500) {
        guard++
        const who = s.currentPlayerId
        s = submitOk(s, who, { type: 'draw-one' })
        if (s.phase.kind === 'after-draw') {
          s = submitOk(s, who, { type: 'keep-drawn' })
        }
      }
      if (s.phase.kind === 'finished' && s.phase.result.reason === 'blocked') {
        found = s
      }
    }
    expect(found).not.toBeNull()
    assertSameGame(found!, roundtrip(found!))
  })
})
