import type { GameState, PlayerId } from '#shared/game'
// A2：候选完整、ID 稳定、Wild 选色在候选内、单候选不联网（候选枚举部分）
import { describe, expect, it } from 'vitest'
import { AI_MAX_CANDIDATES } from '#shared/ai/protocol'
import { enumerateCandidatesFromState, listLegalActions } from '#shared/game'
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

function toP1Turn(state: GameState): GameState {
  return submitOk(state, 'p0', { type: 'play', cardId: state.players.find(p => p.id === 'p0')!.hand[0]!, declareUno: false })
}

describe('候选枚举（A2）', () => {
  it('候选是合法动作的子集且语义一致；出后剩 1 张时恒宣告', () => {
    const state = toP1Turn(gameWith(
      ['red-5-2', 'red-1-2', 'blue-9-1', 'green-9-1', 'yellow-9-1', 'blue-8-1', 'green-8-1'],
      cardOf({ kind: 'number', color: 'red', value: 5 }),
    ))
    expect(state.currentPlayerId).toBe('p1')
    const candidates = enumerateCandidatesFromState(state)!
    const legal = listLegalActions(state, 'p1')
    expect(candidates.length).toBeGreaterThan(1)
    // 每个候选都在合法动作集合中（deep equal 找得到）
    for (const candidate of candidates) {
      const match = legal.some(action => JSON.stringify({ ...sortKeys(action) }) === JSON.stringify({ ...sortKeys(candidate.action) }))
      expect(match, `候选 ${candidate.id} 必须是合法动作`).toBe(true)
    }
    // legal 中出后剩 1 张的变体：候选只取 declareUno=true
    if (state.players.find(p => p.id === 'p1')!.hand.length === 2) {
      for (const candidate of candidates) {
        if (candidate.action.type === 'play') {
          expect(candidate.action.declareUno).toBe(true)
        }
      }
    }
  })

  it('同一快照重复枚举得到相同 ID 与排序', () => {
    const state = toP1Turn(gameWith(
      ['red-5-2', 'red-1-2', 'blue-9-1', 'green-9-1', 'yellow-9-1', 'blue-8-1', 'green-8-1'],
      cardOf({ kind: 'number', color: 'red', value: 5 }),
    ))
    const first = enumerateCandidatesFromState(state)!
    const second = enumerateCandidatesFromState(state)!
    expect(first.map(c => c.id)).toEqual(second.map(c => c.id))
    expect(first).toEqual(second)
  })

  it('wild 候选展开 4 色且顺序红黄绿蓝；ID 格式符合约定', () => {
    const state = toP1Turn(gameWith(
      ['red-5-2', 'red-1-2', 'blue-9-1', 'green-9-1', 'yellow-9-1', 'blue-8-1', 'green-8-1'],
      cardOf({ kind: 'number', color: 'red', value: 5 }),
    ))
    const candidates = enumerateCandidatesFromState(state)!
    const wildPlays = candidates.filter(c => c.action.type === 'play' && c.action.cardId === 'wild-1')
    // p1 手里没有 wild-1——改为直接检查手牌里的 wild：构造 p1 带 wild 的对局
    const wildState = makeGame({
      dealerId: 'p3',
      openingId: cardOf({ kind: 'number', color: 'red', value: 5 }),
      hands: {
        p0: ['red-9-1', 'red-9-2', 'red-8-1', 'red-8-2', 'red-7-1', 'red-7-2', 'red-6-1'],
        p1: ['wild-1', 'blue-1-2', 'blue-2-2', 'blue-3-2', 'blue-4-2', 'blue-5-2', 'blue-6-2'],
        p2: ['green-1-2', 'green-2-2', 'green-3-2', 'green-4-2', 'green-5-2', 'green-6-2', 'green-7-2'],
        p3: ['yellow-1-2', 'yellow-2-2', 'yellow-3-2', 'yellow-4-2', 'yellow-5-2', 'yellow-6-2', 'yellow-7-2'],
      },
    })
    const p1Turn = submitOk(wildState, 'p0', { type: 'play', cardId: 'red-9-1', declareUno: false })
    expect(p1Turn.currentPlayerId).toBe('p1')
    const wildCandidates = enumerateCandidatesFromState(p1Turn)!
      .filter(c => c.action.type === 'play' && c.action.cardId === 'wild-1')
    expect(wildCandidates.map(c => (c.action as { chosenColor?: string }).chosenColor)).toEqual(['red', 'yellow', 'green', 'blue'])
    expect(wildCandidates.map(c => c.id)).toEqual([
      'play_wild-1_red_no_uno',
      'play_wild-1_yellow_no_uno',
      'play_wild-1_green_no_uno',
      'play_wild-1_blue_no_uno',
    ])
    // 无可出的有色牌时只有 wild 候选与抽牌；抽牌候选固定在末尾
    const all = enumerateCandidatesFromState(p1Turn)!
    expect(all.filter(c => c.action.type === 'play').map(c => c.id)).toEqual(wildCandidates.map(c => c.id))
    expect(all.at(-1)!.id).toBe('draw_one')
    void wildPlays
  })

  it('无牌可出的 turn 阶段只有 draw_one 一个候选（forced 场景）', () => {
    // p1 只有黄色牌，顶牌红 5：无可出
    const state = makeGame({
      dealerId: 'p3',
      openingId: cardOf({ kind: 'number', color: 'red', value: 5 }),
      hands: {
        p0: ['red-9-1', 'red-9-2', 'red-8-1', 'red-8-2', 'red-7-1', 'red-7-2', 'red-6-1'],
        p1: ['yellow-1-1', 'yellow-2-1', 'yellow-3-1', 'yellow-4-1', 'yellow-5-1', 'yellow-6-1', 'yellow-7-1'],
        p2: ['green-1-2', 'green-2-2', 'green-3-2', 'green-4-2', 'green-5-2', 'green-6-2', 'green-7-2'],
        p3: ['yellow-1-2', 'yellow-2-2', 'yellow-3-2', 'yellow-4-2', 'yellow-5-2', 'yellow-6-2', 'yellow-7-2'],
      },
    })
    const p1Turn = submitOk(state, 'p0', { type: 'play', cardId: 'red-9-1', declareUno: false })
    const candidates = enumerateCandidatesFromState(p1Turn)!
    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.id).toBe('draw_one')
  })

  it('opening-color 阶段恰好 4 个颜色候选', () => {
    const state = gameWith(
      ['red-5-2', 'red-1-2', 'blue-9-1', 'green-9-1', 'yellow-9-1', 'blue-8-1', 'green-8-1'],
      'wild-2',
      'p2', // 庄家左侧 p3 选色…… p0 需要行动：dealer p0 → 左侧 p1 选色
    )
    // dealer p0 → 左侧 p1：p1 选色
    const wildState = makeGame({
      dealerId: 'p0',
      openingId: 'wild-2',
      hands: {
        p0: ['red-5-2', 'red-1-2', 'blue-9-1', 'green-9-1', 'yellow-9-1', 'blue-8-1', 'green-8-1'],
        p1: ['blue-1-2', 'blue-2-2', 'blue-3-2', 'blue-4-2', 'blue-5-2', 'blue-6-2', 'blue-7-2'],
        p2: ['green-1-2', 'green-2-2', 'green-3-2', 'green-4-2', 'green-5-2', 'green-6-2', 'green-7-2'],
        p3: ['yellow-1-2', 'yellow-2-2', 'yellow-3-2', 'yellow-4-2', 'yellow-5-2', 'yellow-6-2', 'yellow-7-2'],
      },
    })
    expect(wildState.phase.kind).toBe('opening-color')
    expect(wildState.currentPlayerId).toBe('p1')
    const candidates = enumerateCandidatesFromState(wildState)!
    expect(candidates.map(c => c.id)).toEqual(['opening_color_red', 'opening_color_yellow', 'opening_color_green', 'opening_color_blue'])
    void state
  })

  it('after-draw 阶段候选：play（刚抽牌）+ keep_drawn，无 draw_one', () => {
    const state = makeGame({
      dealerId: 'p3',
      openingId: cardOf({ kind: 'number', color: 'red', value: 5 }),
      hands: {
        p0: ['red-9-1', 'red-9-2', 'red-8-1', 'red-8-2', 'red-7-1', 'red-7-2', 'red-6-1'],
        p1: ['yellow-1-1', 'yellow-2-1', 'yellow-3-1', 'yellow-4-1', 'yellow-5-1', 'yellow-6-1', 'yellow-7-1'],
        p2: ['green-1-2', 'green-2-2', 'green-3-2', 'green-4-2', 'green-5-2', 'green-6-2', 'green-7-2'],
        p3: ['yellow-1-2', 'yellow-2-2', 'yellow-3-2', 'yellow-4-2', 'yellow-5-2', 'yellow-6-2', 'yellow-7-2'],
      },
    })
    const p1Turn = submitOk(state, 'p0', { type: 'play', cardId: 'red-9-1', declareUno: false })
    // p1 抽到可出的红牌
    const pile = [...p1Turn.drawPile]
    pile.splice(pile.indexOf('red-5-1'), 1)
    pile.push('red-5-1')
    p1Turn.drawPile = pile
    const afterDraw = submitOk(p1Turn, 'p1', { type: 'draw-one' })
    expect(afterDraw.phase.kind).toBe('after-draw')
    const candidates = enumerateCandidatesFromState(afterDraw)!
    expect(candidates.some(c => c.id === 'draw_one')).toBe(false)
    expect(candidates.some(c => c.id === 'keep_drawn')).toBe(true)
    const plays = candidates.filter(c => c.action.type === 'play')
    expect(plays.length).toBeGreaterThan(0)
    for (const play of plays) {
      if (play.action.type === 'play') {
        expect(play.action.cardId).toBe('red-5-1')
      }
    }
  })

  it('候选数量上限与公式边界（100 + 8×4 + 1 = 133）', () => {
    expect(AI_MAX_CANDIDATES).toBe(133)
    // 常规局面候选远小于上限；伪造超限由服务端校验拒绝（server 测试覆盖）
    const state = toP1Turn(gameWith(
      ['red-5-2', 'red-1-2', 'blue-9-1', 'green-9-1', 'yellow-9-1', 'blue-8-1', 'green-8-1'],
      cardOf({ kind: 'number', color: 'red', value: 5 }),
    ))
    expect(enumerateCandidatesFromState(state)!.length).toBeLessThanOrEqual(AI_MAX_CANDIDATES)
  })
})

function sortKeys(action: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(action).sort(([a], [b]) => a.localeCompare(b)))
}
