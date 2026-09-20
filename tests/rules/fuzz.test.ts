import type { GameState, LegalAction } from '#shared/game'
/**
 * 随机游走模糊测试：随机对局全程保持状态不变量合法。
 * 覆盖 createGame、listLegalActions、applyAction、validateState、
 * projectForAi、enumerateCandidatesFromState 的协同正确性。
 */
import { describe, expect, it } from 'vitest'
import {
  applyAction,
  createGame,
  DECK,
  enumerateCandidatesFromState,
  listLegalActions,
  projectForAi,
  validateState,
} from '#shared/game'

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function totalCards(state: GameState): number {
  return state.drawPile.length + state.discardPile.length
    + state.players.reduce((n, p) => n + p.hand.length, 0)
}

function randomWalk(seed: number, maxSteps = 500): { state: GameState, steps: number } {
  const random = mulberry32(seed)
  let state = createGame({ random, gameId: '12345678-1234-5678-1234-567812345678' })
  for (let step = 0; step < maxSteps; step++) {
    expect(validateState(state).ok, `seed=${seed} step=${step} 状态不变量`).toBe(true)
    expect(totalCards(state), `seed=${seed} step=${step} 牌数守恒`).toBe(DECK.length)
    if (state.phase.kind === 'finished') {
      return { state, steps: step }
    }
    const actor = state.currentPlayerId
    const actions = listLegalActions(state, actor)
    expect(actions.length, `seed=${seed} step=${step} ${actor} 必有合法动作`).toBeGreaterThan(0)
    // AI 视角与候选在任何可决策阶段都可用
    if (actor !== 'p0') {
      expect(() => projectForAi(state, actor), `seed=${seed} step=${step} AI 投影`).not.toThrow()
      const candidates = enumerateCandidatesFromState(state)
      expect(candidates, `seed=${seed} step=${step} 候选枚举`).not.toBeNull()
      expect(candidates!.length, `seed=${seed} step=${step} 候选非空`).toBeGreaterThan(0)
    }
    const action = actions[Math.floor(random() * actions.length)]! as LegalAction
    const result = applyAction(state, {
      actorId: actor,
      gameId: state.gameId,
      expectedRevision: state.revision,
      action,
    })
    expect(result.ok, `seed=${seed} step=${step} 动作 ${JSON.stringify(action)} 意外失败: ${result.ok ? '' : result.message}`).toBe(true)
    if (!result.ok) {
      break
    }
    // revision 每次成功动作恰好 +1
    expect(result.state.revision).toBe(state.revision + 1)
    state = result.state
  }
  expect(validateState(state)).toEqual({ ok: true })
  return { state, steps: maxSteps }
}

describe('随机游走不变量', () => {
  it('多个种子随机对局全程保持合法', () => {
    let finished = 0
    for (let seed = 1; seed <= 40; seed++) {
      const { state, steps } = randomWalk(seed)
      if (state.phase.kind === 'finished') {
        finished++
        const result = state.phase.result
        if (result.reason === 'empty-hand') {
          const winner = state.players.find(p => p.id === result.winnerId)
          expect(winner?.hand.length).toBe(0)
        }
        // 结束后没有任何动作
        expect(listLegalActions(state, 'p0')).toEqual([])
        expect(listLegalActions(state, 'p1')).toEqual([])
        expect(() => projectForAi(state, 'p1')).toThrow()
      }
      expect(steps).toBeGreaterThan(0)
    }
    expect(finished).toBeGreaterThan(0)
  })

  it('结束后重复提交被拒绝', () => {
    // 走到一个结束态
    let state: GameState | null = null
    for (let seed = 100; seed < 200; seed++) {
      const walk = randomWalk(seed)
      if (walk.state.phase.kind === 'finished') {
        state = walk.state
        break
      }
    }
    expect(state).not.toBeNull()
    const finished = state!
    const result = applyAction(finished, {
      actorId: finished.currentPlayerId,
      gameId: finished.gameId,
      expectedRevision: finished.revision,
      action: { type: 'draw-one' },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('invalid-phase')
    }
  })
})
