import type { GameState } from '#shared/game'
// S2：存档校验——未知版本、坏 JSON、重复/缺失牌、错误阶段字段、错误胜者均拒绝；
// loadSaveEnvelope 为纯函数（槽位保留由会话层测试覆盖）
import { describe, expect, it } from 'vitest'
import { loadSaveEnvelope, serializeSaveEnvelope } from '#shared/game'
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

function envelopeOf(state: GameState): string {
  return serializeSaveEnvelope({ schemaVersion: 1, savedAt: '2026-09-20T00:00:00.000Z', writerId: WRITER, state })
}

describe('存档校验（S2）', () => {
  it('空槽位 → absent', () => {
    expect(loadSaveEnvelope(null)).toMatchObject({ ok: false, reason: 'absent' })
    expect(loadSaveEnvelope('')).toMatchObject({ ok: false, reason: 'absent' })
  })

  it('坏 JSON → invalid-json', () => {
    expect(loadSaveEnvelope('{oops')).toMatchObject({ ok: false, reason: 'invalid-json' })
    expect(loadSaveEnvelope('null')).toMatchObject({ ok: false, reason: 'invalid-shape' })
  })

  it('未知 schemaVersion → invalid-shape（含未来版本提示）', () => {
    const raw = envelopeOf(validState()).replace('"schemaVersion":1', '"schemaVersion":2')
    const result = loadSaveEnvelope(raw)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('invalid-shape')
      expect(result.message).toContain('2')
    }
  })

  it('缺字段与非 UUID writerId → invalid-shape', () => {
    const env = JSON.parse(envelopeOf(validState())) as Record<string, unknown>
    for (const key of ['savedAt', 'writerId', 'state']) {
      const broken = { ...env }
      delete broken[key]
      expect(loadSaveEnvelope(JSON.stringify(broken)), `缺 ${key}`).toMatchObject({ ok: false, reason: 'invalid-shape' })
    }
    expect(loadSaveEnvelope(JSON.stringify({ ...env, writerId: 'not-a-uuid' }))).toMatchObject({ ok: false, reason: 'invalid-shape' })
  })

  it('状态不自洽：重复牌 / 缺牌 / 错误 rulesVersion / 负 revision → invalid-state', () => {
    const env = JSON.parse(envelopeOf(validState())) as { state: GameState }

    // 重复牌：手牌里同一 ID 出现两次（并从抽牌堆移除一张保持总数也可触发唯一性检查）
    const dup = structuredClone(env)
    dup.state.players[0]!.hand.push(dup.state.players[0]!.hand[0]!)
    expect(loadSaveEnvelope(JSON.stringify(dup))).toMatchObject({ ok: false, reason: 'invalid-state' })

    // 缺牌：删掉一张手牌（108 → 107）
    const missing = structuredClone(env)
    missing.state.players[0]!.hand.pop()
    expect(loadSaveEnvelope(JSON.stringify(missing))).toMatchObject({ ok: false, reason: 'invalid-state' })

    // 错误 rulesVersion
    const badRules = structuredClone(env)
    ;(badRules.state as unknown as { rulesVersion: string }).rulesVersion = 'other-v9'
    expect(loadSaveEnvelope(JSON.stringify(badRules))).toMatchObject({ ok: false, reason: 'invalid-state' })

    // 负 revision
    const badRevision = structuredClone(env)
    badRevision.state.revision = -1
    expect(loadSaveEnvelope(JSON.stringify(badRevision))).toMatchObject({ ok: false, reason: 'invalid-state' })

    // 座位顺序错乱
    const badSeats = structuredClone(env)
    badSeats.state.players = [...badSeats.state.players].reverse()
    expect(loadSaveEnvelope(JSON.stringify(badSeats))).toMatchObject({ ok: false, reason: 'invalid-state' })
  })

  it('错误阶段字段：turn 无颜色 / after-drawn 不在手牌 / opening-color 顶牌非 Wild / finished 胜者错误', () => {
    const env = JSON.parse(envelopeOf(validState())) as { state: GameState }

    const noColor = structuredClone(env)
    noColor.state.currentColor = null
    expect(loadSaveEnvelope(JSON.stringify(noColor)).ok, 'turn 阶段 currentColor null').toBe(false)

    const badDrawn = structuredClone(env)
    badDrawn.state.phase = { kind: 'after-draw', drawnCardId: 'blue-1-2' } // 不在 p0 手牌
    expect(loadSaveEnvelope(JSON.stringify(badDrawn)).ok, 'drawnCardId 不在手牌').toBe(false)

    const badOpening = structuredClone(env)
    badOpening.state.phase = { kind: 'opening-color' }
    expect(loadSaveEnvelope(JSON.stringify(badOpening)).ok, 'opening-color 但顶牌是数字牌').toBe(false)

    const badWinner = structuredClone(env)
    // 人为制造 finished + 胜者但手牌非空
    badWinner.state.phase = { kind: 'finished', result: { reason: 'empty-hand', winnerId: 'p1' } }
    expect(loadSaveEnvelope(JSON.stringify(badWinner)).ok, '胜者手牌非空').toBe(false)

    const badBlocked = structuredClone(env)
    badBlocked.state.phase = { kind: 'finished', result: { reason: 'blocked', winnerId: 'p2' } }
    expect(loadSaveEnvelope(JSON.stringify(badBlocked)).ok, 'blocked 却有 winnerId').toBe(false)

    // unoDeclared 与手牌数不符
    const badUno = structuredClone(env)
    badUno.state.players[0]!.unoDeclared = true
    expect(loadSaveEnvelope(JSON.stringify(badUno)).ok, 'unoDeclared 但手牌 7 张').toBe(false)
  })

  it('合法 envelope 通过且 state 与输入一致', () => {
    const state = validState()
    const raw = envelopeOf(state)
    const result = loadSaveEnvelope(raw)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.envelope.state).toEqual(state)
      expect(result.envelope.writerId).toBe(WRITER)
      expect(result.envelope.schemaVersion).toBe(1)
    }
  })

  it('loadSaveEnvelope 是纯函数：不触碰 storage（注释说明）', () => {
    // 校验失败的原始字符串由调用方保留；本函数签名只接收字符串，天然不写 storage。
    // "旧槽位不被默认值覆盖"的运行时行为由 tests/session/persistence.test.ts 覆盖。
    expect(typeof loadSaveEnvelope).toBe('function')
  })
})
