import type { GameState } from '#shared/game'
// S2 回归（问题 5）：任意 JSON 结构都必须得到受控的校验结果，不允许抛异常。
// 覆盖空玩家、缺失字段、错误手牌、阶段与庄家等场景；校验失败时保留原始槽位。
import { describe, expect, it } from 'vitest'
import { loadSaveEnvelope, serializeSaveEnvelope, validateState } from '#shared/game'
import { cardOf, makeGame } from '../rules/helpers'

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
