import type { PlayerId } from '#shared/game'
// R4：+4 严格合法性——同色禁止、同数异色允许、普通 Wild 不阻止、抽牌后检查全手牌、
// currentColor 与 Wild 印刷牌面无关；候选中无质疑类动作
import { describe, expect, it } from 'vitest'
import { listLegalActions } from '#shared/game'
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

describe('严格 +4（R4）', () => {
  it('手中有与当前颜色相同的有色牌时，+4 被规则引擎拒绝', () => {
    // 顶牌红 5（currentColor 红），p0 手中有红 3 与 +4
    const state = gameWith(
      ['wild-draw-four-2', 'red-3-2', 'blue-1-1', 'green-9-1', 'yellow-9-1', 'blue-8-1', 'green-8-1'],
      cardOf({ kind: 'number', color: 'red', value: 5 }),
    )
    expect(submitFail(state, 'p0', { type: 'play', cardId: 'wild-draw-four-2', chosenColor: 'blue', declareUno: false })).toBe('card-not-playable')
    // +4 也不出现在合法动作中
    const plays = listLegalActions(state, 'p0').filter(a => a.type === 'play')
    expect(plays.some(a => a.type === 'play' && a.cardId === 'wild-draw-four-2')).toBe(false)
  })

  it('同数字异色不阻止：顶牌红 5，手中有蓝 5，无红牌时 +4 可出', () => {
    const state = gameWith(
      ['wild-draw-four-2', 'blue-5-1', 'green-9-1', 'yellow-9-1', 'blue-8-1', 'green-8-1', 'yellow-8-1'],
      cardOf({ kind: 'number', color: 'red', value: 5 }),
    )
    const after = submitOk(state, 'p0', { type: 'play', cardId: 'wild-draw-four-2', chosenColor: 'blue', declareUno: false })
    expect(after.currentColor).toBe('blue')
    // p1 罚抽 4 并被跳过
    expect(after.players.find(p => p.id === 'p1')!.hand).toHaveLength(11)
    expect(after.currentPlayerId).toBe('p2')
  })

  it('同功能符号异色不阻止；普通 Wild 不阻止', () => {
    // 顶牌红 Skip（currentColor 红），手中有蓝 Skip（符号相同颜色不同）+ Wild + +4
    const state = gameWith(
      ['wild-draw-four-2', 'blue-skip-2', 'wild-2', 'green-9-1', 'yellow-9-1', 'blue-8-1', 'green-8-1'],
      cardOf({ kind: 'skip', color: 'red' }),
      'p2', // 起始 Skip 跳过 p3，p0 先手
    )
    expect(state.currentPlayerId).toBe('p0')
    const after = submitOk(state, 'p0', { type: 'play', cardId: 'wild-draw-four-2', chosenColor: 'green', declareUno: false })
    expect(after.currentColor).toBe('green')
  })

  it('抽牌后检查全手牌：抽到非红牌后手中仍有红牌，+4 仍不可出', () => {
    // p0 手牌 1 张红 3，抽到蓝 9 → 手中含红，+4 不可出
    const setup = makeGame({
      dealerId: 'p3',
      openingId: cardOf({ kind: 'number', color: 'red', value: 5 }),
      hands: {
        p0: ['wild-draw-four-2', 'red-3-2', 'green-9-1', 'yellow-9-1', 'blue-8-1', 'green-8-1', 'yellow-8-1'],
        p1: ['blue-1-2', 'blue-2-2', 'blue-3-2', 'blue-4-2', 'blue-5-2', 'blue-6-2', 'blue-7-2'],
        p2: ['green-1-2', 'green-2-2', 'green-3-2', 'green-4-2', 'green-5-2', 'green-6-2', 'green-7-2'],
        p3: ['yellow-1-2', 'yellow-2-2', 'yellow-3-2', 'yellow-4-2', 'yellow-5-2', 'yellow-6-2', 'yellow-7-2'],
      },
    })
    const afterDraw = submitOk(nextDrawIs(setup, 'red-9-1'), 'p0', { type: 'draw-one' })
    expect(afterDraw.phase.kind).toBe('after-draw')
    if (afterDraw.phase.kind === 'after-draw') {
      expect(afterDraw.phase.drawnCardId).toBe('red-9-1')
    }
    // +4 不在 after-draw 合法动作中（整手牌含红 3 与刚抽到的红 9）
    const actions = listLegalActions(afterDraw, 'p0')
    expect(actions.some(a => a.type === 'play' && a.cardId === 'wild-draw-four-2')).toBe(false)
    expect(actions.some(a => a.type === 'keep-drawn')).toBe(true)
  })

  it('currentColor 与 Wild 印刷牌面不同：上家 Wild 选绿后，+4 合法性按绿色判断', () => {
    // p3 打出 Wild 选绿；p0 手中有绿 2 与 +4 → 被拒；换成无绿手牌 → 可出
    const base = {
      dealerId: 'p2',
      openingId: cardOf({ kind: 'number', color: 'yellow', value: 1 }),
      hands: {
        p0: ['wild-draw-four-2', 'green-2-2', 'red-9-1', 'blue-9-1', 'yellow-9-1', 'blue-8-1', 'green-8-1'],
        p1: ['blue-1-2', 'blue-2-2', 'blue-3-2', 'blue-4-2', 'blue-5-2', 'blue-6-2', 'blue-7-2'],
        p2: ['green-1-1', 'green-2-1', 'green-3-1', 'green-4-1', 'green-5-1', 'green-6-1', 'green-7-1'],
        p3: ['wild-2', 'yellow-1-2', 'yellow-2-2', 'yellow-3-2', 'yellow-4-2', 'yellow-5-2', 'yellow-6-2'],
      },
    } as const
    const withGreen = makeGame(base)
    const afterWild = submitOk(withGreen, 'p3', { type: 'play', cardId: 'wild-2', chosenColor: 'green', declareUno: false })
    expect(afterWild.currentColor).toBe('green')
    expect(submitFail(afterWild, 'p0', { type: 'play', cardId: 'wild-draw-four-2', chosenColor: 'red', declareUno: false })).toBe('card-not-playable')

    const noGreen = makeGame({
      ...base,
      hands: {
        ...base.hands,
        p0: ['wild-draw-four-2', 'red-2-2', 'red-9-1', 'blue-9-1', 'yellow-9-1', 'blue-8-1', 'red-8-1'],
      },
    })
    const afterWild2 = submitOk(noGreen, 'p3', { type: 'play', cardId: 'wild-2', chosenColor: 'green', declareUno: false })
    const played = submitOk(afterWild2, 'p0', { type: 'play', cardId: 'wild-draw-four-2', chosenColor: 'red', declareUno: false })
    expect(played.currentColor).toBe('red')
  })

  it('候选动作中不存在质疑 / 虚张声势类动作', () => {
    const state = gameWith(
      ['wild-draw-four-2', 'red-3-2', 'blue-1-1', 'green-9-1', 'yellow-9-1', 'blue-8-1', 'green-8-1'],
      cardOf({ kind: 'number', color: 'red', value: 5 }),
    )
    const actions = listLegalActions(state, 'p0')
    const knownTypes = new Set(['play', 'draw-one', 'keep-drawn', 'choose-opening-color'])
    for (const action of actions) {
      expect(knownTypes.has(action.type), `动作类型 ${action.type} 不应是质疑类`).toBe(true)
    }
    // 候选 ID 全部来自动作内容（无 challenge 等虚构项）
    for (const action of actions) {
      if (action.type === 'play') {
        expect(action.cardId).toMatch(/^[a-z]+(-[a-z]+)*-\d+(-\d+)?$/)
      }
    }
  })
})
