import type { GameState } from '#shared/game'
// S2 回归（问题 5）：任意 JSON 结构都必须得到受控的校验结果，不允许抛异常。
// 覆盖空玩家、缺失字段、错误手牌、阶段与庄家等场景；校验失败时保留原始槽位。
import { describe, expect, it } from 'vitest'
import { loadSaveEnvelope, serializeSaveEnvelope, validateState } from '#shared/game'
import { cardOf, makeGame, submitOk } from '../rules/helpers'

const WRITER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

function validState(): GameState {
  return makeGame({
    dealerId: 'p3',
    openingId: cardOf({ kind: 'number', color: 'red', value: 5 }),
    hands: {
      p0: ['red-5-2', 'red-1-2', 'blue-9-1', 'green-9-1', 'yellow-9-1', 'blue-8-1', 'green-8-1'],
      p1: ['blue-1-2', 'blue-2-2', 'blue-3-2', 'blue-4-2', 'blue-5-2', 'blue-6-2', 'blue-7-2'],
      p2: ['green-1-2', 'green-2-2', 'green-3-2', 'green-4-2', 'green-5-2', 'green-6-2', 'green-7-2'],
      p3: ['yellow-1-2', 'yellow-2-2', 'yellow-3-2', 'yellow-4-2', 'yellow-5-2', 'yellow-6-2', 'yellow-7-2'],
    },
  })
}

function mutate(mutator: (state: Record<string, unknown>) => void): unknown {
  const state = structuredClone(validState()) as unknown as Record<string, unknown>
  mutator(state)
  return state
}

/**
 * 合法 after-draw 状态：p0 抽到可出的 red-9-2 后停在决策点。
 * 用于验证依赖当前手牌的语义校验（归属 / 可出性）在结构被破坏时受控失败。
 */
function afterDrawState(): GameState {
  const state = validState()
  const pile = [...state.drawPile]
  pile.splice(pile.indexOf('red-9-2'), 1)
  pile.push('red-9-2')
  state.drawPile = pile
  const afterDraw = submitOk(state, 'p0', { type: 'draw-one' })
  if (afterDraw.phase.kind !== 'after-draw') {
    throw new Error('afterDrawState: 未进入 after-draw 阶段')
  }
  return afterDraw
}

/** 复制一份合法 after-draw 状态并按 JSON 结构改写（可删除字段）。 */
function mutateAfterDraw(mutator: (state: Record<string, unknown>) => void): unknown {
  const state = structuredClone(afterDrawState()) as unknown as Record<string, unknown>
  mutator(state)
  return state
}

/** 断言校验返回受控失败结果（不抛异常、ok 为 false、带可读错误）。 */
function expectRejected(state: unknown, label: string) {
  let result: ReturnType<typeof validateState> | undefined
  expect(() => {
    result = validateState(state)
  }, `${label} 不应抛异常`).not.toThrow()
  expect(result!.ok, `${label} 应校验失败`).toBe(false)
  if (!result!.ok) {
    expect(result!.errors.length, `${label} 应带错误信息`).toBeGreaterThan(0)
  }
}

describe('validateState 对任意 JSON 结构不抛异常（问题 5）', () => {
  const cases: Array<[string, () => unknown]> = [
    ['非对象：null', () => null],
    ['非对象：数组', () => []],
    ['非对象：字符串', () => 'not-a-state'],
    ['非对象：数字', () => 42],
    ['空对象', () => ({})],
    ['players 全部为 null', () => mutate((s) => {
      s.players = [null, null, null, null]
    })],
    ['players 部分为 null', () => mutate((s) => {
      s.players = [s.players[0], null, s.players[2], s.players[3]]
    })],
    ['players 含 undefined 洞', () => mutate((s) => {
      s.players = [s.players[0], undefined, s.players[2], s.players[3]]
    })],
    ['players 数量不足', () => mutate((s) => {
      s.players = [s.players[0]]
    })],
    ['players 缺失', () => mutate((s) => {
      delete s.players
    })],
    ['玩家 hand 不是数组', () => mutate((s) => {
      s.players[0].hand = 'oops'
    })],
    ['玩家 hand 含未知牌', () => mutate((s) => {
      s.players[0].hand = ['nope-1']
    })],
    ['玩家 hand 为 null', () => mutate((s) => {
      s.players[0].hand = null
    })],
    ['玩家 id 错位', () => mutate((s) => {
      s.players[0].id = 'p3'
    })],
    ['dealerId 非法', () => mutate((s) => {
      s.dealerId = 'p9'
    })],
    ['dealerId 缺失', () => mutate((s) => {
      delete s.dealerId
    })],
    ['currentPlayerId 非法', () => mutate((s) => {
      s.currentPlayerId = 'x'
    })],
    ['revision 为字符串', () => mutate((s) => {
      s.revision = '1'
    })],
    ['revision 为负', () => mutate((s) => {
      s.revision = -3
    })],
    ['drawPile 缺失', () => mutate((s) => {
      delete s.drawPile
    })],
    ['drawPile 含重复牌', () => mutate((s) => {
      s.drawPile = [s.drawPile[0], s.drawPile[0]]
    })],
    ['discardPile 为空', () => mutate((s) => {
      s.discardPile = []
    })],
    ['phase 缺失', () => mutate((s) => {
      delete s.phase
    })],
    ['phase 未知类型', () => mutate((s) => {
      s.phase = { kind: 'mystery' }
    })],
    ['phase 为 null', () => mutate((s) => {
      s.phase = null
    })],
    ['turn 阶段 currentColor 为 null', () => mutate((s) => {
      s.phase = { kind: 'turn' }
      s.currentColor = null
    })],
    ['opening-color 阶段且庄家非法（旧版会抛错）', () => mutate((s) => {
      s.phase = { kind: 'opening-color' }
      s.currentColor = null
      s.dealerId = 'bad'
    })],
    ['after-draw 阶段且玩家为 null（旧版会抛错）', () => mutate((s) => {
      s.phase = { kind: 'after-draw', drawnCardId: 'red-9-1' }
      s.players = [null, null, null, null]
    })],
    ['after-draw 阶段 drawnCardId 缺失', () => mutate((s) => {
      s.phase = { kind: 'after-draw' }
    })],
    ['finished 阶段且玩家为 null（旧版会抛错）', () => mutate((s) => {
      s.phase = { kind: 'finished', result: { reason: 'empty-hand', winnerId: 'p1' } }
      s.players = [null, null, null, null]
    })],
    ['finished 结果缺失', () => mutate((s) => {
      s.phase = { kind: 'finished' }
    })],
    ['finished 结果原因未知', () => mutate((s) => {
      s.phase = { kind: 'finished', result: { reason: 'weird', winnerId: null } }
    })],
    ['recentEvents 含 null 事件', () => mutate((s) => {
      s.recentEvents = [null]
    })],
    ['recentEvents 不是数组', () => mutate((s) => {
      s.recentEvents = {}
    })],
    ['blockedTurnCount 为字符串', () => mutate((s) => {
      s.blockedTurnCount = '0'
    })],
  ]

  for (const [label, build] of cases) {
    it(label, () => {
      expectRejected(build(), label)
    })
  }

  it('合法状态仍然通过（回归保护）', () => {
    expect(validateState(validState())).toEqual({ ok: true })
  })

  it('坏结构经 loadSaveEnvelope 得到 invalid-state，而不是抛异常', () => {
    const badStates: unknown[] = [
      mutate((s) => {
        s.players = [null, null, null, null]
      }),
      mutate((s) => {
        s.phase = { kind: 'finished', result: { reason: 'empty-hand', winnerId: 'p1' } }
        s.players = [null, null, null, null]
      }),
      mutate((s) => {
        s.dealerId = 'bad'
        s.phase = { kind: 'opening-color' }
        s.currentColor = null
      }),
    ]
    for (const state of badStates) {
      const raw = serializeSaveEnvelope({
        schemaVersion: 1,
        savedAt: '2026-09-20T00:00:00.000Z',
        writerId: WRITER,
        state: state as GameState,
      })
      let result: ReturnType<typeof loadSaveEnvelope> | undefined
      expect(() => {
        result = loadSaveEnvelope(raw)
      }).not.toThrow()
      expect(result!.ok).toBe(false)
      if (!result!.ok) {
        expect(result!.reason).toBe('invalid-state')
      }
    }
  })
})

// 第二轮审查（问题 3）：合法 after-draw 状态的手牌被改成非数组时，
// 归属校验（includes）与决策上下文构造必须先验证运行时结构，
// 不能只记录结构错误后继续执行依赖有效结构的语义校验。
describe('after-draw 畸形手牌受控失败（第二轮审查问题 3）', () => {
  type PlayerRecord = Record<string, unknown>
  const handOf = (state: Record<string, unknown>, index: number): PlayerRecord =>
    (state.players as PlayerRecord[])[index]!

  const shapes: Array<[string, () => unknown]> = [
    ['hand 为对象', () => mutateAfterDraw((s) => { handOf(s, 0).hand = {} })],
    ['hand 为数字', () => mutateAfterDraw((s) => { handOf(s, 0).hand = 7 })],
    ['hand 为字符串', () => mutateAfterDraw((s) => { handOf(s, 0).hand = 'red-9-2' })],
    ['hand 为 null', () => mutateAfterDraw((s) => { handOf(s, 0).hand = null })],
    ['hand 缺失', () => mutateAfterDraw((s) => { delete handOf(s, 0).hand })],
    ['hand 含非字符串项', () => mutateAfterDraw((s) => { handOf(s, 0).hand = ['red-9-2', 42] })],
    ['hand 为空数组', () => mutateAfterDraw((s) => { handOf(s, 0).hand = [] })],
    ['非行动者 hand 为对象', () => mutateAfterDraw((s) => { handOf(s, 2).hand = {} })],
    ['drawnCardId 为对象', () => mutateAfterDraw((s) => { (s.phase as Record<string, unknown>).drawnCardId = {} })],
  ]

  for (const [label, build] of shapes) {
    it(`${label}：validateState 受控失败且不抛异常`, () => {
      expectRejected(build(), label)
    })
  }

  it('畸形 JSON 经 loadSaveEnvelope 得到 invalid-state，而不是抛异常', () => {
    for (const [label, build] of shapes) {
      const raw = serializeSaveEnvelope({
        schemaVersion: 1,
        savedAt: '2026-09-20T00:00:00.000Z',
        writerId: WRITER,
        state: build() as GameState,
      })
      let result: ReturnType<typeof loadSaveEnvelope> | undefined
      expect(() => {
        result = loadSaveEnvelope(raw)
      }, `${label} 不应抛异常`).not.toThrow()
      expect(result!.ok, `${label} 应校验失败`).toBe(false)
      if (!result!.ok) {
        expect(result!.reason, label).toBe('invalid-state')
      }
    }
  })

  it('合法 after-draw 仍通过，且归属与可出性语义校验未被跳过', () => {
    const base = afterDrawState()
    expect(validateState(base)).toEqual({ ok: true })
    const raw = serializeSaveEnvelope({
      schemaVersion: 1,
      savedAt: '2026-09-20T00:00:00.000Z',
      writerId: WRITER,
      state: base,
    })
    expect(loadSaveEnvelope(raw).ok, '合法 after-draw 存档应可读取').toBe(true)

    // drawnCardId 不在当前手牌（结构完好，必须继续报告语义错误）
    const notInHand = structuredClone(base) as unknown as Record<string, unknown>
    ;(notInHand.phase as Record<string, unknown>).drawnCardId = 'blue-1-2'
    const notInHandResult = validateState(notInHand)
    expect(notInHandResult.ok).toBe(false)
    if (!notInHandResult.ok) {
      expect(notInHandResult.errors.join(';')).toContain('必须在当前手牌中')
    }

    // drawnCardId 在手牌中但当前不可出
    const notPlayable = structuredClone(base) as unknown as Record<string, unknown>
    ;(notPlayable.phase as Record<string, unknown>).drawnCardId = 'blue-9-1'
    const notPlayableResult = validateState(notPlayable)
    expect(notPlayableResult.ok).toBe(false)
    if (!notPlayableResult.ok) {
      expect(notPlayableResult.errors.join(';')).toContain('必须是可出的牌')
    }
  })
})

// 第三轮审查（问题 2）：合法 after-draw 状态的弃牌堆被改成 null / 删除时，
// 决策上下文构造依赖有效弃牌堆，必须先验证结构再进入深层语义校验。
describe('after-draw 畸形牌堆受控失败（第三轮审查问题 2）', () => {
  const piles: Array<[string, () => unknown]> = [
    ['discardPile 为 null', () => mutateAfterDraw((s) => { s.discardPile = null })],
    ['discardPile 缺失', () => mutateAfterDraw((s) => { delete s.discardPile })],
    ['discardPile 为字符串', () => mutateAfterDraw((s) => { s.discardPile = 'red-9-2' })],
    ['discardPile 为数字', () => mutateAfterDraw((s) => { s.discardPile = 7 })],
    ['discardPile 为对象', () => mutateAfterDraw((s) => { s.discardPile = {} })],
    ['discardPile 含未知牌', () => mutateAfterDraw((s) => { s.discardPile = ['nope-1'] })],
    ['drawPile 为 null', () => mutateAfterDraw((s) => { s.drawPile = null })],
    ['drawPile 缺失', () => mutateAfterDraw((s) => { delete s.drawPile })],
  ]

  for (const [label, build] of piles) {
    it(`${label}：validateState 受控失败且不抛异常`, () => {
      expectRejected(build(), label)
    })
  }

  it('畸形牌堆经 loadSaveEnvelope 得到 invalid-state，而不是抛异常', () => {
    for (const [label, build] of piles) {
      const raw = serializeSaveEnvelope({
        schemaVersion: 1,
        savedAt: '2026-09-20T00:00:00.000Z',
        writerId: WRITER,
        state: build() as GameState,
      })
      let result: ReturnType<typeof loadSaveEnvelope> | undefined
      expect(() => {
        result = loadSaveEnvelope(raw)
      }, `${label} 不应抛异常`).not.toThrow()
      expect(result!.ok, `${label} 应校验失败`).toBe(false)
      if (!result!.ok) {
        expect(result!.reason, label).toBe('invalid-state')
      }
    }
  })

  it('弃牌堆结构错误时跳过深层校验，但独立于牌堆的归属校验仍然报告', () => {
    // 弃牌堆损坏：只报告结构错误，不构造决策上下文
    const brokenDiscard = mutateAfterDraw((s) => {
      s.discardPile = null
    })
    const brokenResult = validateState(brokenDiscard)
    expect(brokenResult.ok).toBe(false)
    if (!brokenResult.ok) {
      const joined = brokenResult.errors.join(';')
      expect(joined).toContain('discardPile 必须是目录内 CardId 数组')
      expect(joined, '依赖弃牌堆的可出性校验应被跳过').not.toContain('必须是可出的牌')
    }

    // 抽牌堆损坏不影响归属校验（该检查只依赖玩家手牌与弃牌堆）
    const brokenDraw = structuredClone(afterDrawState()) as unknown as Record<string, unknown>
    ;(brokenDraw.phase as Record<string, unknown>).drawnCardId = 'blue-1-2'
    brokenDraw.drawPile = null
    const drawResult = validateState(brokenDraw)
    expect(drawResult.ok).toBe(false)
    if (!drawResult.ok) {
      expect(drawResult.errors.join(';')).toContain('必须在当前手牌中')
    }
  })

  it('合法 after-draw 的归属与可出性校验保持有效（回归保护）', () => {
    expect(validateState(afterDrawState())).toEqual({ ok: true })
  })
})
