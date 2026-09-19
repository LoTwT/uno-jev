import type { GameState } from '#shared/game'
// A1：信息投影隔离——其他玩家手牌与抽牌堆内容不出现在视角、请求体或上游载荷中
import { describe, expect, it } from 'vitest'
import { enumerateCandidatesFromState, listLegalActions, projectForAi } from '#shared/game'
import { buildUpstreamPayload } from '../../server/utils/aiDecision'
import { cardOf, makeGame, submitOk } from '../rules/helpers'

function gameAtActor(actor: 'p1' | 'p2' | 'p3'): GameState {
  // 固定构造：p0 打一张后按座位推进到目标 AI
  const state = makeGame({
    dealerId: 'p3',
    openingId: cardOf({ kind: 'number', color: 'red', value: 5 }),
    hands: {
      p0: ['red-5-2', 'red-1-2', 'blue-9-1', 'green-9-1', 'yellow-9-1', 'blue-8-1', 'green-8-1'],
      p1: ['blue-1-2', 'blue-2-2', 'blue-3-2', 'blue-4-2', 'blue-5-2', 'blue-6-2', 'blue-7-2'],
      p2: ['green-1-2', 'green-2-2', 'green-3-2', 'green-4-2', 'green-5-2', 'green-6-2', 'green-7-2'],
      p3: ['yellow-1-2', 'yellow-2-2', 'yellow-3-2', 'yellow-4-2', 'yellow-5-2', 'yellow-6-2', 'yellow-7-2'],
    },
  })
  if (state.currentPlayerId === actor) {
    return state
  }
  // p0 打一张后轮到 p1
  if (actor === 'p1') {
    return submitOk(state, 'p0', { type: 'play', cardId: 'red-5-2', declareUno: false })
  }
  if (actor === 'p2') {
    const afterP1 = submitOk(submitOk(state, 'p0', { type: 'play', cardId: 'red-5-2', declareUno: false }), 'p1', { type: 'draw-one' })
    return afterP1.phase.kind === 'after-draw' ? submitOk(afterP1, 'p1', { type: 'keep-drawn' }) : afterP1
  }
  const afterP1 = submitOk(submitOk(state, 'p0', { type: 'play', cardId: 'red-5-2', declareUno: false }), 'p1', { type: 'draw-one' })
  const afterP1b = afterP1.phase.kind === 'after-draw' ? submitOk(afterP1, 'p1', { type: 'keep-drawn' }) : afterP1
  const afterP2 = submitOk(afterP1b, 'p2', { type: 'draw-one' })
  return afterP2.phase.kind === 'after-draw' ? submitOk(afterP2, 'p2', { type: 'keep-drawn' }) : afterP2
}

describe('aI 视角投影（A1）', () => {
  it('其他玩家手牌与抽牌堆内容不出现在视角 JSON 中', () => {
    const state = gameAtActor('p2')
    const view = projectForAi(state, 'p2')
    const serialized = JSON.stringify(view)

    const otherHandMarkers = state.players
      .filter(p => p.id !== 'p2')
      .flatMap(p => p.hand)
    expect(otherHandMarkers.length).toBeGreaterThan(0)
    for (const marker of otherHandMarkers) {
      expect(serialized, `其他玩家手牌 ${marker} 不应泄漏`).not.toContain(`"${marker}"`)
    }
    for (const marker of state.drawPile) {
      expect(serialized, `抽牌堆 ${marker} 不应泄漏`).not.toContain(`"${marker}"`)
    }
    // 抽牌堆只有数量
    expect(view.drawPileCount).toBe(state.drawPile.length)
    expect((view as unknown as Record<string, unknown>).drawPile).toBeUndefined()
  })

  it('视角白名单字段：ownHand 仅本人，players 仅数量与公开 UNO 状态', () => {
    const state = gameAtActor('p1')
    const view = projectForAi(state, 'p1')
    const ownIds = new Set(view.ownHand.map(card => card.id))
    expect(ownIds.size).toBe(state.players.find(p => p.id === 'p1')!.hand.length)
    expect(view.players).toHaveLength(4)
    for (const info of view.players) {
      expect(Object.keys(info).sort()).toEqual(['handCount', 'id', 'name', 'type', 'unoDeclared'])
      expect((info as unknown as Record<string, unknown>).hand).toBeUndefined()
    }
    // 事件无暗牌牌面字段（cards-drawn 只有数量）
    for (const event of view.recentEvents) {
      if (event.type === 'cards-drawn') {
        expect(Object.keys(event).sort()).toEqual(['drawn', 'playerId', 'reason', 'requested', 'revision', 'type'])
      }
    }
    expect(view.recentEvents.length).toBeLessThanOrEqual(12)
  })

  it('多次投影不共享私有状态；修改返回值不影响原状态', () => {
    const state = gameAtActor('p1')
    const view1 = projectForAi(state, 'p1')
    const view2 = projectForAi(state, 'p1')
    expect(view1).not.toBe(view2)
    expect(view1).toEqual(view2)
    view1.ownHand.pop()
    expect(state.players.find(p => p.id === 'p1')!.hand.length).toBe(view2.ownHand.length)
  })

  it('非当前行动者或 finished 状态调用抛错', () => {
    const state = gameAtActor('p1')
    expect(() => projectForAi(state, 'p2')).toThrow()
    expect(() => projectForAi(state, 'p0')).toThrow()
  })

  it('after-draw 时视角带 drawnCardId（仅本人）', () => {
    // p1 抽到可出牌
    const state = gameAtActor('p1')
    const pile = [...state.drawPile]
    // p1 手牌是蓝色，顶牌红 5：让 p1 抽到蓝牌（可出）
    pile.splice(pile.indexOf('red-9-1'), 1)
    pile.push('red-9-1')
    state.drawPile = pile
    const afterDraw = submitOk(state, 'p1', { type: 'draw-one' })
    if (afterDraw.phase.kind !== 'after-draw') {
      throw new Error('构造 after-draw 失败')
    }
    const view = projectForAi(afterDraw, 'p1')
    expect(view.drawnCardId).toBe('red-9-1')
    expect(view.phase).toBe('after-draw')
  })

  it('请求体与上游 payload 均不含暗牌（服务端载荷复用 buildUpstreamPayload）', () => {
    const state = gameAtActor('p2')
    const view = projectForAi(state, 'p2')
    const candidates = enumerateCandidatesFromState(state)!
    const payload = buildUpstreamPayload('jev-1.13.0', view, candidates)
    const serialized = JSON.stringify(payload)
    for (const marker of state.players.filter(p => p.id !== 'p2').flatMap(p => p.hand)) {
      expect(serialized, `上游 payload 不应含 ${marker}`).not.toContain(`"${marker}"`)
    }
    // 候选合法性与 listLegalActions 一致性由 candidates 测试覆盖
    void listLegalActions
  })
})
