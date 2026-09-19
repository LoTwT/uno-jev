import type { GameState, PlayerId } from '#shared/game'
// R7：牌堆耗尽——刚好耗尽触发重洗、罚抽中途重洗、保留顶牌/当前颜色、牌数守恒、
// 无可回收牌时实抽不足、4 回合无进展和局、keep-drawn 不计数、出牌重置计数
import { describe, expect, it } from 'vitest'
import { listLegalActions } from '#shared/game'
import { cardOf, makeGame, submitOk } from './helpers'

function baseGame() {
  // p0 持红数字便于打出到弃牌堆；p1 持蓝 +2 便于罚抽场景
  return makeGame({
    dealerId: 'p3',
    openingId: cardOf({ kind: 'number', color: 'red', value: 9 }),
    hands: {
      p0: ['red-1-2', 'red-2-2', 'red-3-2', 'red-4-2', 'red-5-2', 'red-6-2', 'red-draw-two-2'],
      p1: ['blue-draw-two-2', 'blue-1-2', 'blue-2-2', 'blue-3-2', 'blue-4-2', 'blue-5-2', 'blue-6-2'],
      p2: ['green-1-2', 'green-2-2', 'green-3-2', 'green-4-2', 'green-5-2', 'green-6-2', 'green-7-2'],
      p3: ['yellow-1-2', 'yellow-2-2', 'yellow-3-2', 'yellow-4-2', 'yellow-5-2', 'yellow-6-2', 'yellow-7-2'],
    },
  })
}

function totalCards(state: GameState): number {
  return state.drawPile.length + state.discardPile.length
    + state.players.reduce((n, p) => n + p.hand.length, 0)
}

function assertConservation(state: GameState, where: string) {
  expect(totalCards(state), `${where} 牌数守恒`).toBe(108)
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

/** p0 依次打出指定红牌（其余玩家抽牌轮转）。 */
function p0Plays(state: GameState, cardsToPlay: string[]): GameState {
  let current = state
  for (const cardId of cardsToPlay) {
    current = submitOk(current, 'p0', { type: 'play', cardId, declareUno: false })
    current = rotateTo(current, 'p0')
  }
  return current
}

/** 持续抽牌（抽到可出的保留），直到抽牌堆降到目标张数（不含 0 抽）。 */
function driveDraws(state: GameState, stopAtPile: number): GameState {
  let current = state
  let guard = 0
  while (current.drawPile.length > stopAtPile && guard < 400) {
    guard++
    assertConservation(current, 'driveDraws')
    const who = current.currentPlayerId
    current = submitOk(current, who, { type: 'draw-one' })
    if (current.phase.kind === 'after-draw') {
      current = submitOk(current, who, { type: 'keep-drawn' })
    }
  }
  expect(current.drawPile.length, 'driveDraws 停止条件').toBe(stopAtPile)
  return current
}

describe('牌堆耗尽与重洗（R7）', () => {
  it('弃牌堆只有顶牌时无可回收：实抽不足并记录应抽/实抽', () => {
    // 只抽不打：弃牌堆 = 1（起始牌）
    let state = baseGame()
    state = driveDraws(state, 0)
    expect(state.discardPile.length).toBe(1)
    const actor = state.currentPlayerId
    const after = submitOk(state, actor, { type: 'draw-one' })
    const drawEvent = after.recentEvents.filter(e => e.revision === after.revision).find(e => e.type === 'cards-drawn')!
    expect(drawEvent).toMatchObject({ requested: 1, drawn: 0, reason: 'turn' })
    expect(after.blockedTurnCount).toBe(1)
    // 正常回合抽不到牌：结束该回合，轮到下一位
    expect(after.currentPlayerId).not.toBe(actor)
    assertConservation(after, '无可回收')
  })

  it('抽牌堆刚好耗尽：下一次抽牌重洗弃牌堆（保留顶牌）', () => {
    let state = baseGame()
    // p0 打出 3 张牌 → 弃牌堆 4 张（起始 + 3）
    state = p0Plays(state, ['red-1-2', 'red-2-2', 'red-3-2'])
    expect(state.discardPile.length).toBe(4)
    const colorBefore = state.currentColor
    state = driveDraws(state, 0)
    expect(state.drawPile.length).toBe(0)
    expect(state.discardPile.length).toBe(4)
    const topBefore = state.discardPile[state.discardPile.length - 1]

    const actor = state.currentPlayerId
    const after = submitOk(state, actor, { type: 'draw-one' })
    // 重洗：回收 3 张（弃牌堆 4 - 顶牌），抽出 1 张后剩 2
    const reshuffleEvent = after.recentEvents.find(e => e.type === 'pile-reshuffled')
    expect(reshuffleEvent).toMatchObject({ recycledCount: 3 })
    expect(after.discardPile).toEqual([topBefore])
    expect(after.drawPile.length).toBe(2)
    // 当前颜色不因重洗改变，也不重新触发顶牌效果
    expect(after.currentColor).toBe(colorBefore)
    expect(after.recentEvents.filter(e => e.type === 'player-skipped').length).toBe(0)
    assertConservation(after, '重洗后')
  })

  it('罚抽中途重洗：+2 罚抽 2 张跨越堆耗尽', () => {
    let state = baseGame()
    // p0 打出红 +2 作为顶牌（此后任意 +2 按符号匹配）
    state = p0Plays(state, ['red-1-2', 'red-2-2', 'red-draw-two-2'])
    state = driveDraws(state, 0)
    expect(state.drawPile.length).toBe(0)
    // 0 抽轮转（每次 +1 计数，最多 3 次不触发和局）到 p1
    let current = state
    let guard = 0
    while (current.currentPlayerId !== 'p1' && guard < 4) {
      guard++
      current = submitOk(current, current.currentPlayerId, { type: 'draw-one' })
    }
    expect(current.currentPlayerId).toBe('p1')
    expect(current.blockedTurnCount).toBeLessThan(4)
    const p2Before = current.players.find(p => p.id === 'p2')!.hand.length
    // p1 打出蓝 +2（与顶牌红 +2 同符号匹配）
    const played = submitOk(current, 'p1', { type: 'play', cardId: 'blue-draw-two-2', declareUno: false })
    // 出牌重置无进展计数
    expect(played.blockedTurnCount).toBe(0)
    // p2 罚抽 2：堆耗尽触发重洗后抽足
    expect(played.players.find(p => p.id === 'p2')!.hand).toHaveLength(p2Before + 2)
    const drawEvent = played.recentEvents.filter(e => e.revision === played.revision).find(e => e.type === 'cards-drawn' && e.reason === 'draw-two')!
    expect(drawEvent).toMatchObject({ playerId: 'p2', requested: 2, drawn: 2 })
    expect(played.recentEvents.some(e => e.type === 'pile-reshuffled')).toBe(true)
    // p2 被跳过，轮到 p3
    expect(played.currentPlayerId).toBe('p3')
    assertConservation(played, '罚抽中途重洗')
  })

  it('无可回收牌时罚抽：实抽少于应抽，跳过照常生效且不记欠牌', () => {
    // 只抽不打 → 弃牌堆 1 张；p0 出红 +2 后弃牌堆 2 张（顶牌 + 出的牌），仅能回收 1 张
    let state = baseGame()
    state = driveDraws(state, 0)
    // 0 抽轮转到 p0（最多 3 次，计数 < 4）
    let current = state
    let guard = 0
    while (current.currentPlayerId !== 'p0' && guard < 4) {
      guard++
      current = submitOk(current, current.currentPlayerId, { type: 'draw-one' })
    }
    expect(current.currentPlayerId).toBe('p0')
    const p1Before = current.players.find(p => p.id === 'p1')!.hand.length
    // p0 出红 +2（currentColor 红）
    const played = submitOk(current, 'p0', { type: 'play', cardId: 'red-draw-two-2', declareUno: false })
    // p1 应抽 2：抽完回收的 1 张后再无可回收牌，实抽 1，不记欠牌
    const drawEvent = played.recentEvents.filter(e => e.revision === played.revision).find(e => e.type === 'cards-drawn' && e.reason === 'draw-two')!
    expect(drawEvent).toMatchObject({ playerId: 'p1', requested: 2, drawn: 1 })
    expect(played.players.find(p => p.id === 'p1')!.hand).toHaveLength(p1Before + 1)
    // 弃牌堆仅剩顶牌，抽牌堆空
    expect(played.discardPile).toHaveLength(1)
    expect(played.drawPile).toHaveLength(0)
    // 跳过照常生效：轮到 p2
    expect(played.currentPlayerId).toBe('p2')
    assertConservation(played, '罚抽不足')
  })

  it('连续 4 个无进展回合 → 和局（含主动放弃合法牌的情形）', () => {
    let state = baseGame()
    state = driveDraws(state, 0)
    // 此后每人的正常回合都抽不到牌；玩家手中有合法牌也计入（主动放弃）
    const hasPlayable = listLegalActions(state, state.currentPlayerId).some(a => a.type === 'play')
    void hasPlayable
    let current = state
    let zeroDrawTurns = 0
    for (let step = 0; step < 8; step++) {
      if (current.phase.kind === 'finished') {
        break
      }
      const before = current.blockedTurnCount
      current = submitOk(current, current.currentPlayerId, { type: 'draw-one' })
      if (current.phase.kind === 'turn' || current.phase.kind === 'finished') {
        // 实抽 0 的正常回合
        expect(current.blockedTurnCount).toBe(before + 1)
        zeroDrawTurns++
      }
    }
    expect(zeroDrawTurns).toBeGreaterThanOrEqual(4)
    expect(current.phase.kind).toBe('finished')
    if (current.phase.kind === 'finished') {
      expect(current.phase.result).toEqual({ reason: 'blocked', winnerId: null })
    }
  })

  it('keep-drawn 不增加无进展计数；成功出牌重置计数', () => {
    const state = baseGame()
    // 抽到可出牌（红）→ after-draw → keep-drawn：计数保持 0
    const pile = [...state.drawPile]
    pile.splice(pile.indexOf('red-9-1'), 1)
    pile.push('red-9-1')
    state.drawPile = pile
    let current = submitOk(state, 'p0', { type: 'draw-one' })
    expect(current.phase.kind).toBe('after-draw')
    current = submitOk(current, 'p0', { type: 'keep-drawn' })
    expect(current.blockedTurnCount).toBe(0)
    // 无进展计数中途累积后，成功出牌重置：0 抽轮转（计数 < 4）到 p0 后出牌
    const exhausted = driveDraws(baseGame(), 0)
    const firstZero = submitOk(exhausted, exhausted.currentPlayerId, { type: 'draw-one' })
    expect(firstZero.blockedTurnCount).toBe(1)
    let toP0 = firstZero
    let guard = 0
    while (toP0.currentPlayerId !== 'p0' && toP0.phase.kind !== 'finished' && guard < 4) {
      guard++
      toP0 = submitOk(toP0, toP0.currentPlayerId, { type: 'draw-one' })
    }
    expect(toP0.currentPlayerId).toBe('p0')
    expect(toP0.blockedTurnCount).toBeLessThan(4)
    const played = submitOk(toP0, 'p0', { type: 'play', cardId: 'red-1-2', declareUno: false })
    expect(played.blockedTurnCount).toBe(0)
  })
})
