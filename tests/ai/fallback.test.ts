import type { DecisionContext } from '#shared/game'
// A4：确定性兜底——相同视角相同结果；固定排序规则逐字段验证；来源标记与描述内容
import { describe, expect, it } from 'vitest'
import { bestFallbackColor, candidateIdOf, CHOOSE_ACTION_INSTRUCTIONS, chooseFallbackAction, describeCandidate, enumerateCandidates, getCard } from '#shared/game'

/** 手工构造决策上下文（不经过 GameState）。 */
function ctx(own: string[], currentColor: 'red' | 'yellow' | 'green' | 'blue' | null, top: string, phase: DecisionContext['phase'] = 'turn'): DecisionContext {
  return {
    phase,
    actorId: 'p1',
    ownHand: own.map(id => getCard(id)!),
    currentColor,
    topCard: getCard(top)!,
    drawnCardId: null,
  }
}

describe('兜底策略确定性（A4）', () => {
  it('相同视角 + 相同候选多次调用结果完全一致', () => {
    const context = ctx(['red-1-1', 'red-2-1', 'blue-5-1', 'wild-1', 'wild-draw-four-1'], 'red', 'red-9-1')
    const candidates = enumerateCandidates(context)
    const first = chooseFallbackAction(context, candidates)
    for (let i = 0; i < 5; i++) {
      expect(chooseFallbackAction(context, candidates)!.id).toBe(first!.id)
    }
    // 候选枚举本身也可复现
    expect(enumerateCandidates(context).map(c => c.id)).toEqual(candidates.map(c => c.id))
  })

  it('能立即出完的动作无条件优先（即使有 draw_one）', () => {
    const context = ctx(['green-5-1'], 'green', 'green-9-1')
    const candidates = enumerateCandidates(context)
    expect(candidates.map(c => c.id)).toContain('draw_one')
    expect(chooseFallbackAction(context, candidates)!.id).toBe('play_green-5-1_none_no_uno')
  })

  it('有出牌候选时优先出牌；无可出候选选 draw_one', () => {
    const withPlay = ctx(['red-1-1', 'red-2-1'], 'red', 'red-9-1')
    expect(chooseFallbackAction(withPlay, enumerateCandidates(withPlay))!.action.type).toBe('play')

    const withoutPlay = ctx(['blue-1-1', 'blue-2-1'], 'red', 'red-9-1')
    const candidates = enumerateCandidates(withoutPlay)
    expect(candidates.every(c => c.action.type !== 'play')).toBe(true)
    expect(chooseFallbackAction(withoutPlay, candidates)!.id).toBe('draw_one')
  })

  it('排序字段 1：出牌后该颜色剩余手牌数降序优先于牌类', () => {
    // 顶牌绿 9 / currentColor 绿：red-9 按数字可出（出后红剩 3 张），
    // green-draw-two 按颜色可出（出后绿剩 0 张）——数字牌因剩余更多而胜过 +2
    const context = ctx(['red-9-1', 'red-1-1', 'red-2-1', 'red-4-1', 'green-draw-two-1'], 'green', 'green-9-1')
    const choice = chooseFallbackAction(context, enumerateCandidates(context))!
    expect(choice.id).toBe('play_red-9-1_none_no_uno')
  })

  it('排序字段 2：同剩余数时牌类 +2 > Skip > Reverse > 数字', () => {
    // 各手牌互不同色，出后该颜色剩余均为 0
    // +2 > Skip：顶牌绿 +2，蓝 +2 按符号、绿 Skip 按颜色
    const plus2 = ctx(['blue-draw-two-1', 'green-skip-1', 'yellow-8-1'], 'green', 'green-draw-two-1')
    expect(chooseFallbackAction(plus2, enumerateCandidates(plus2))!.id).toBe('play_blue-draw-two-1_none_no_uno')

    // Skip > 数字：顶牌绿 Skip，蓝 Skip 按符号、绿 9 按颜色
    const skip = ctx(['blue-skip-1', 'green-9-1', 'yellow-8-1'], 'green', 'green-skip-1')
    expect(chooseFallbackAction(skip, enumerateCandidates(skip))!.id).toBe('play_blue-skip-1_none_no_uno')

    // Reverse > 数字：顶牌绿 Reverse
    const reverse = ctx(['blue-reverse-1', 'green-9-1', 'yellow-8-1'], 'green', 'green-reverse-1')
    expect(chooseFallbackAction(reverse, enumerateCandidates(reverse))!.id).toBe('play_blue-reverse-1_none_no_uno')

    // Skip > Reverse：顶牌绿 Skip，绿 Reverse 按颜色
    const skipVsReverse = ctx(['blue-skip-1', 'green-reverse-1', 'yellow-8-1'], 'green', 'green-skip-1')
    expect(chooseFallbackAction(skipVsReverse, enumerateCandidates(skipVsReverse))!.id).toBe('play_blue-skip-1_none_no_uno')

    // 数字降序：同为可出数字，9 优先于 3（剩余数同为 1）
    const numbers = ctx(['red-3-1', 'red-9-1', 'yellow-8-1'], 'red', 'red-1-1')
    expect(chooseFallbackAction(numbers, enumerateCandidates(numbers))!.id).toBe('play_red-9-1_none_no_uno')

    // 普通 Wild：无可出有色牌时仍选 Wild 而非抽牌
    const onlyWild = ctx(['wild-1', 'wild-2', 'yellow-8-1'], 'red', 'red-1-1')
    expect(chooseFallbackAction(onlyWild, enumerateCandidates(onlyWild))!.id).toBe('play_wild-1_yellow_no_uno')
  })

  it('排序字段 3/4/5：颜色红黄绿蓝、CardId 字典序（数字降序已在上例覆盖）', () => {
    // 颜色顺序（同数字不同色均与顶牌同数字匹配，出后各自颜色剩余均为 0）
    const colors = ctx(['yellow-7-1', 'red-7-1', 'green-7-1', 'blue-7-1', 'yellow-8-1'], 'red', 'red-9-1')
    expect(chooseFallbackAction(colors, enumerateCandidates(colors))!.id).toBe('play_red-7-1_none_no_uno')

    // CardId 字典序（两张同色同数字副本 -1 优先于 -2；剩余数同为 1）
    const copies = ctx(['red-7-2', 'red-7-1', 'yellow-8-1'], 'red', 'red-9-1')
    expect(chooseFallbackAction(copies, enumerateCandidates(copies))!.id).toBe('play_red-7-1_none_no_uno')
  })

  it('wild 选色按剩余有色手牌最多优先，平局按红黄绿蓝', () => {
    // 蓝 2 张 > 红 1 > 绿 0：选蓝
    const blue = ctx(['wild-1', 'blue-1-1', 'blue-2-1', 'red-1-1'], 'red', 'red-9-1')
    expect(chooseFallbackAction(blue, enumerateCandidates(blue))!.id).toBe('play_wild-1_blue_no_uno')

    // 平局（各 0 张有色）：红优先
    const tie = ctx(['wild-1'], 'red', 'red-9-1')
    expect(chooseFallbackAction(tie, enumerateCandidates(tie))!.id).toBe('play_wild-1_red_no_uno')

    // bestFallbackColor 单元断言
    expect(bestFallbackColor([])).toBe('red')
    expect(bestFallbackColor([getCard('green-1-1')!, getCard('green-2-1')!])).toBe('green')
    expect(bestFallbackColor([getCard('blue-1-1')!, getCard('yellow-1-1')!])).toBe('yellow')
  })

  it('opening-color：选剩余最多的颜色；after-draw 有可出候选必出', () => {
    const opening = ctx(['blue-1-1', 'blue-2-1', 'red-1-1', 'yellow-1-1'], null, 'wild-1', 'opening-color')
    const candidates = enumerateCandidates(opening)
    expect(candidates.map(c => c.id)).toEqual(['opening_color_red', 'opening_color_yellow', 'opening_color_green', 'opening_color_blue'])
    expect(chooseFallbackAction(opening, candidates)!.id).toBe('opening_color_blue')

    const afterDraw = ctx(['blue-1-1', 'red-5-1', 'yellow-9-1'], 'red', 'red-9-1', 'after-draw')
    const drawContext: DecisionContext = { ...afterDraw, drawnCardId: 'red-5-1' }
    const drawCandidates = enumerateCandidates(drawContext)
    const choice = chooseFallbackAction(drawContext, drawCandidates)!
    expect(choice.action.type).toBe('play')
    expect(choice.id).not.toBe('keep_drawn')
  })

  it('candidateIdOf 与枚举 ID 一致', () => {
    const context = ctx(['wild-1', 'red-1-1'], 'red', 'red-9-1')
    for (const candidate of enumerateCandidates(context)) {
      expect(candidateIdOf(candidate.action)).toBe(candidate.id)
    }
  })
})

describe('候选描述（英文，用于 TypeSafe criteria）', () => {
  const context = ctx(['red-5-1', 'blue-3-1', 'wild-1', 'wild-draw-four-1'], 'red', 'red-9-1')

  it('描述包含牌面英文名与确定效果', () => {
    // 数字牌（同色匹配）
    const numberCtx = ctx(['red-5-1', 'blue-3-1', 'yellow-2-1'], 'red', 'red-9-1')
    const red5 = describeCandidate(numberCtx, { id: 'play_red-5-1_none_no_uno', action: { type: 'play', cardId: 'red-5-1', declareUno: false } })!
    expect(red5).toContain('Red 5')
    expect(red5).toContain('current color')
    expect(red5).toContain('2 cards left')

    // +4（手中无红牌，合法）
    const plus4Ctx = ctx(['blue-3-1', 'yellow-2-1', 'wild-draw-four-1'], 'red', 'red-9-1')
    const plus4 = describeCandidate(plus4Ctx, { id: 'play_wild-draw-four-1_red_no_uno', action: { type: 'play', cardId: 'wild-draw-four-1', chosenColor: 'red', declareUno: false } })!
    expect(plus4).toContain('Wild Draw Four')
    expect(plus4).toContain('red')
    expect(plus4).toContain('draws 4 cards')
    expect(plus4).toContain('skipped')

    // +2 与 Skip / Reverse 的确定效果
    const drawTwoCtx = ctx(['green-draw-two-1', 'blue-3-1'], 'green', 'green-9-1')
    const drawTwo = describeCandidate(drawTwoCtx, { id: 'play_green-draw-two-1_none_no_uno', action: { type: 'play', cardId: 'green-draw-two-1', declareUno: false } })!
    expect(drawTwo).toContain('draws 2 cards')

    const skipCtx = ctx(['green-skip-1', 'blue-3-1'], 'green', 'green-9-1')
    expect(describeCandidate(skipCtx, { id: 'x', action: { type: 'play', cardId: 'green-skip-1', declareUno: false } })).toContain('skipped')

    const reverseCtx = ctx(['green-reverse-1', 'blue-3-1'], 'green', 'green-9-1')
    expect(describeCandidate(reverseCtx, { id: 'x', action: { type: 'play', cardId: 'green-reverse-1', declareUno: false } })).toContain('direction of play reverses')

    // Wild 选色
    const wildCtx = ctx(['wild-1', 'blue-3-1'], 'red', 'red-9-1')
    const wild = describeCandidate(wildCtx, { id: 'play_wild-1_blue_no_uno', action: { type: 'play', cardId: 'wild-1', chosenColor: 'blue', declareUno: false } })!
    expect(wild).toContain('wild card')
    expect(wild).toContain('blue')

    // 抽牌
    const draw = describeCandidate(wildCtx, { id: 'draw_one', action: { type: 'draw-one' } })!
    expect(draw).toContain('Draw one card')
    void context
  })

  it('宣告与赢局的描述', () => {
    const twoCards = ctx(['red-5-1', 'blue-3-1'], 'red', 'red-9-1')
    const candidates = enumerateCandidates(twoCards)
    const declared = describeCandidate(twoCards, candidates.find(c => c.id === 'play_red-5-1_none_uno')!)
    expect(declared).toContain('declare UNO')

    const winning = ctx(['red-5-1'], 'red', 'red-9-1')
    const winCandidates = enumerateCandidates(winning)
    const winPlay = describeCandidate(winning, winCandidates.find(c => c.action.type === 'play')!)
    expect(winPlay).toContain('win the round')
  })

  it('固定英文指令', () => {
    expect(CHOOSE_ACTION_INSTRUCTIONS).toContain('choose exactly one candidate action')
    expect(CHOOSE_ACTION_INSTRUCTIONS).toContain('first player to run out of cards')
  })
})
