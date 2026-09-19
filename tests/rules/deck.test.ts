import type { GameState, PlayerId } from '#shared/game'
// R1：108 张牌组成、ID 唯一性与稳定性、洗牌守恒、6 种起始牌效果（含多张起始 +4）
import { describe, expect, it } from 'vitest'
import {
  applyAction,
  createGame,
  DECK,
  listLegalActions,
  validateState,
} from '#shared/game'
import { cardOf, makeGame, mulberry32, playerOf } from './helpers'

function totalCards(state: GameState): number {
  return state.drawPile.length + state.discardPile.length
    + state.players.reduce((n, p) => n + p.hand.length, 0)
}

describe('牌组目录', () => {
  it('共 108 张，每色数量正确，Wild 类各 4 张', () => {
    expect(DECK.length).toBe(108)
    for (const color of ['red', 'yellow', 'green', 'blue'] as const) {
      const cards = DECK.filter(c => c.color === color)
      expect(cards.filter(c => c.kind === 'number' && c.value === 0)).toHaveLength(1)
      for (let v = 1; v <= 9; v++) {
        expect(cards.filter(c => c.kind === 'number' && c.value === v)).toHaveLength(2)
      }
      expect(cards.filter(c => c.kind === 'skip')).toHaveLength(2)
      expect(cards.filter(c => c.kind === 'reverse')).toHaveLength(2)
      expect(cards.filter(c => c.kind === 'draw-two')).toHaveLength(2)
      expect(cards).toHaveLength(25)
    }
    expect(DECK.filter(c => c.kind === 'wild')).toHaveLength(4)
    expect(DECK.filter(c => c.kind === 'wild-draw-four')).toHaveLength(4)
  })

  it('实体 ID 唯一且稳定（同面值两张牌是不同实例）', () => {
    expect(new Set(DECK.map(c => c.id)).size).toBe(108)
    expect(DECK.find(c => c.id === 'red-5-1')).toBeDefined()
    expect(DECK.find(c => c.id === 'red-5-2')).toBeDefined()
    expect(cardOf({ kind: 'number', color: 'red', value: 5, copy: 1 })).not.toBe(
      cardOf({ kind: 'number', color: 'red', value: 5, copy: 2 }),
    )
  })
})

describe('createGame 洗牌与发牌', () => {
  it('注入随机：洗牌不丢不增、4 人各 7 张、状态合法', () => {
    for (const seed of [1, 7, 42, 2026]) {
      const state = createGame({ random: mulberry32(seed), gameId: '12345678-1234-5678-1234-567812345678' })
      expect(validateState(state).ok, `seed=${seed}`).toBe(true)
      expect(totalCards(state)).toBe(108)
      expect(new Set([...state.drawPile, ...state.discardPile, ...state.players.flatMap(p => p.hand)]).size).toBe(108)
      for (const player of state.players) {
        // 起始牌为 Draw Two 时，庄家左侧玩家抽 2 张（9 张）
        expect([7, 9]).toContain(player.hand.length)
      }
      const total = state.players.reduce((n, p) => n + p.hand.length, 0)
      expect(total).toBeLessThanOrEqual(30)
      expect(state.discardPile).toHaveLength(1)
      // 抽牌堆 = 108 - 28 发牌 - 1 起始牌 -（起始 +2 时的罚抽 2 张）
      const dealtTotal = state.players.reduce((n, p) => n + p.hand.length, 0)
      expect(state.drawPile.length).toBe(108 - dealtTotal - 1)
      expect(state.revision).toBe(0)
      expect(state.rulesVersion).toBe('classic-single-v1')
      // 同 seed 重复创建结果一致（随机注入可复现）
      const again = createGame({ random: mulberry32(seed), gameId: '12345678-1234-5678-1234-567812345678' })
      expect(again.drawPile).toEqual(state.drawPile)
      expect(again.players.map(p => p.hand)).toEqual(state.players.map(p => p.hand))
    }
  })
})

describe('起始牌效果（R1）', () => {
  const defaultHands = (patch: Partial<Record<PlayerId, string[]>>) => {
    // 使用 -2 副本，避免与 cardOf 默认取的 -1 副本起始牌冲突
    const hands: Record<PlayerId, string[]> = {
      p0: ['red-1-2', 'red-2-2', 'red-3-2', 'red-4-2', 'red-5-2', 'red-6-2', 'red-7-2'],
      p1: ['blue-1-2', 'blue-2-2', 'blue-3-2', 'blue-4-2', 'blue-5-2', 'blue-6-2', 'blue-7-2'],
      p2: ['green-1-2', 'green-2-2', 'green-3-2', 'green-4-2', 'green-5-2', 'green-6-2', 'green-7-2'],
      p3: ['yellow-1-2', 'yellow-2-2', 'yellow-3-2', 'yellow-4-2', 'yellow-5-2', 'yellow-6-2', 'yellow-7-2'],
    }
    return { ...hands, ...patch }
  }

  it('数字牌：以该颜色开局，庄家左侧玩家先行动', () => {
    const state = makeGame({
      dealerId: 'p2',
      openingId: cardOf({ kind: 'number', color: 'blue', value: 6 }),
      hands: defaultHands({}),
    })
    expect(state.currentColor).toBe('blue')
    expect(state.currentPlayerId).toBe('p3')
    expect(state.direction).toBe(1)
    expect(state.phase.kind).toBe('turn')
    expect(listLegalActions(state, 'p3').length).toBeGreaterThan(0)
  })

  it('skip：跳过庄家左侧玩家，由其下一位行动', () => {
    const state = makeGame({
      dealerId: 'p0',
      openingId: cardOf({ kind: 'skip', color: 'green' }),
      hands: defaultHands({}),
    })
    expect(state.currentColor).toBe('green')
    expect(state.currentPlayerId).toBe('p2') // p1 被跳过
    const skipEvent = state.recentEvents.find(e => e.type === 'player-skipped')
    expect(skipEvent).toMatchObject({ playerId: 'p1', reason: 'opening-skip' })
  })

  it('reverse：方向改为 -1，庄家先行动', () => {
    const state = makeGame({
      dealerId: 'p1',
      openingId: cardOf({ kind: 'reverse', color: 'red' }),
      hands: defaultHands({ p1: ['red-9-2', 'blue-1-2', 'blue-2-2', 'blue-3-2', 'blue-4-2', 'blue-5-2', 'blue-6-2'] }),
    })
    expect(state.direction).toBe(-1)
    expect(state.currentColor).toBe('red')
    expect(state.currentPlayerId).toBe('p1') // 庄家本人先行动
    // 反方向继续：庄家出牌后轮到 p0（direction=-1）
    const result = dealApply(state, 'p1', { type: 'play', cardId: 'red-9-2', declareUno: false })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.state.currentPlayerId).toBe('p0')
    }
  })

  it('draw Two：庄家左侧抽 2 张并跳过，由其下一位行动', () => {
    const state = makeGame({
      dealerId: 'p3',
      openingId: cardOf({ kind: 'draw-two', color: 'yellow' }),
      hands: defaultHands({}),
    })
    expect(state.currentColor).toBe('yellow')
    expect(playerOf(state, 'p0').hand).toHaveLength(9) // 7 + 2 罚抽
    expect(state.currentPlayerId).toBe('p1') // p0 抽 2 后被跳过
    const drawEvent = state.recentEvents.find(e => e.type === 'cards-drawn')
    expect(drawEvent).toMatchObject({ playerId: 'p0', requested: 2, drawn: 2, reason: 'opening-draw-two' })
    expect(state.recentEvents.find(e => e.type === 'player-skipped')).toMatchObject({ playerId: 'p0' })
  })

  it('wild：进入 opening-color，庄家左侧玩家选色', () => {
    const state = makeGame({
      dealerId: 'p2',
      openingId: 'wild-1',
      hands: defaultHands({}),
    })
    expect(state.phase.kind).toBe('opening-color')
    expect(state.currentColor).toBeNull()
    expect(state.currentPlayerId).toBe('p3')
    expect(state.direction).toBe(1)
    // 四个颜色都是合法动作
    const actions = listLegalActions(state, 'p3')
    expect(actions).toHaveLength(4)
    expect(actions.every(a => a.type === 'choose-opening-color')).toBe(true)
  })

  it('wild Draw Four：不进弃牌堆、不罚牌，翻出替代起始牌', () => {
    const state = makeGame({
      dealerId: 'p0',
      openingId: cardOf({ kind: 'number', color: 'green', value: 3 }),
      openingPlusFours: ['wild-draw-four-1'],
      hands: defaultHands({}),
    })
    // 替代起始牌生效
    expect(state.discardPile).toHaveLength(1)
    expect(state.discardPile[0]).toBe(cardOf({ kind: 'number', color: 'green', value: 3 }))
    expect(state.currentColor).toBe('green')
    // 无罚抽事件
    expect(state.recentEvents.some(e => e.type === 'cards-drawn')).toBe(false)
    // +4 回到抽牌堆（108 守恒已由 makeGame 的 validateState 保证）
    expect(state.drawPile).toContain('wild-draw-four-1')
    expect(totalCards(state)).toBe(108)
  })

  it('连续多张起始 +4：全部放回洗匀，最终以替代牌开局', () => {
    const state = makeGame({
      dealerId: 'p1',
      openingId: cardOf({ kind: 'number', color: 'red', value: 2 }),
      openingPlusFours: ['wild-draw-four-1', 'wild-draw-four-2'],
      hands: defaultHands({}),
    })
    expect(state.discardPile[0]).toBe(cardOf({ kind: 'number', color: 'red', value: 2 }))
    expect(state.currentColor).toBe('red')
    expect(state.drawPile).toContain('wild-draw-four-1')
    expect(state.drawPile).toContain('wild-draw-four-2')
    expect(state.recentEvents.some(e => e.type === 'cards-drawn')).toBe(false)
    expect(validateState(state).ok).toBe(true)
  })

  it('起始牌为 +4 之后的替代牌也可以是 Skip / Draw Two / Wild', () => {
    // 替代牌 Wild → opening-color
    const wildState = makeGame({
      dealerId: 'p0',
      openingId: 'wild-2',
      openingPlusFours: ['wild-draw-four-3'],
      hands: defaultHands({}),
    })
    expect(wildState.phase.kind).toBe('opening-color')
    expect(wildState.currentPlayerId).toBe('p1')
    expect(wildState.drawPile).toContain('wild-draw-four-3')
    // 替代牌 +2 → 罚抽生效
    const drawTwoState = makeGame({
      dealerId: 'p0',
      openingId: cardOf({ kind: 'draw-two', color: 'blue' }),
      openingPlusFours: ['wild-draw-four-3'],
      hands: defaultHands({}),
    })
    expect(drawTwoState.currentColor).toBe('blue')
    expect(playerOf(drawTwoState, 'p1').hand).toHaveLength(9)
    expect(drawTwoState.currentPlayerId).toBe('p2')
  })
})

function dealApply(state: GameState, actorId: PlayerId, action: Parameters<typeof applyAction>[2]) {
  return applyAction(state, { actorId, gameId: state.gameId, expectedRevision: state.revision, action })
}
