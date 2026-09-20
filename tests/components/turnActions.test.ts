// @vitest-environment happy-dom
// 问题 1 回归：Wild / +4 选色后的出牌按钮状态。
// 区分"牌需要选色"与"尚未选色"——选色完成后（colorPending=false）出牌必须可用，
// 普通回合、after-draw 与 UNO 宣告场景一致；未选色时按钮禁用并给出原因。
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { getCard } from '#shared/game'
import TurnActions from '~/components/game/TurnActions.vue'

const wild = getCard('wild-1')!
const wildDrawFour = getCard('wild-draw-four-1')!
const redFive = getCard('red-5-1')!

function mountActions(overrides: Partial<InstanceType<typeof TurnActions>['$props']> = {}) {
  return mount(TurnActions, {
    props: {
      active: true,
      selectedCard: wild,
      canDeclareUno: false,
      colorPending: true,
      afterDraw: false,
      drawnCard: null,
      phaseHint: '轮到你了',
      ...overrides,
    },
  })
}

// 出牌按钮固定为模板中的第一个按钮（文案随阶段变化：出牌 / 出这张）
function playButton(wrapper: ReturnType<typeof mountActions>) {
  return wrapper.findAll('button')[0]!
}

function unoButton(wrapper: ReturnType<typeof mountActions>) {
  return wrapper.findAll('button').find(button => button.text().includes('UNO 并出牌'))!
}

describe('turnActions 选色状态（问题 1）', () => {
  it('wild 未选色：出牌禁用并提示先选色', () => {
    const wrapper = mountActions({ colorPending: true })
    expect(playButton(wrapper).attributes('disabled')).toBeDefined()
    expect(playButton(wrapper).attributes('title')).toBe('先为万能牌选择颜色')
  })

  it('wild 已选色：出牌可用并提交出牌动作', async () => {
    const wrapper = mountActions({ colorPending: false })
    const button = playButton(wrapper)
    expect(button.attributes('disabled')).toBeUndefined()
    expect(button.attributes('title')).toBeUndefined()
    await button.trigger('click')
    expect(wrapper.emitted('play')).toEqual([[{ declareUno: false }]])
  })

  it('+4 已选色：出牌可用（与 Wild 一致）', async () => {
    const wrapper = mountActions({ selectedCard: wildDrawFour, colorPending: false })
    const button = playButton(wrapper)
    expect(button.attributes('disabled')).toBeUndefined()
    await button.trigger('click')
    expect(wrapper.emitted('play')).toEqual([[{ declareUno: false }]])
  })

  it('after-draw 抽到 Wild：未选色禁用、已选色可用（回归旧版漏检）', async () => {
    const pending = mountActions({ afterDraw: true, drawnCard: wild, colorPending: true })
    expect(playButton(pending).attributes('disabled')).toBeDefined()
    expect(playButton(pending).attributes('title')).toBe('先为万能牌选择颜色')
    expect(playButton(pending).text()).toBe('出这张')

    const chosen = mountActions({ afterDraw: true, drawnCard: wild, colorPending: false })
    const button = playButton(chosen)
    expect(button.attributes('disabled')).toBeUndefined()
    await button.trigger('click')
    expect(chosen.emitted('play')).toEqual([[{ declareUno: false }]])
  })

  it('uNO 宣告场景：剩 2 张出 Wild 到剩 1 张，已选色后 UNO 按钮可用并携带 declareUno', async () => {
    const pending = mountActions({ canDeclareUno: true, colorPending: true })
    expect(unoButton(pending).attributes('disabled')).toBeDefined()
    expect(unoButton(pending).attributes('title')).toBe('先为万能牌选择颜色')

    const chosen = mountActions({ canDeclareUno: true, colorPending: false })
    const button = unoButton(chosen)
    expect(button.attributes('disabled')).toBeUndefined()
    await button.trigger('click')
    expect(chosen.emitted('play')).toEqual([[{ declareUno: true }]])
  })

  it('普通有色牌不受选色状态影响（colorPending 恒为 false）', async () => {
    const wrapper = mountActions({ selectedCard: redFive, colorPending: false })
    const button = playButton(wrapper)
    expect(button.attributes('disabled')).toBeUndefined()
    await button.trigger('click')
    expect(wrapper.emitted('play')).toEqual([[{ declareUno: false }]])
  })

  it('未选牌时普通回合禁用并提示先选牌；非真人回合全部禁用', () => {
    const noSelection = mountActions({ selectedCard: null, colorPending: false })
    expect(playButton(noSelection).attributes('disabled')).toBeDefined()
    expect(playButton(noSelection).attributes('title')).toBe('先在手牌中选择一张牌')

    const notActive = mountActions({ active: false, colorPending: false })
    expect(playButton(notActive).attributes('disabled')).toBeDefined()
    expect(playButton(notActive).attributes('title')).toBe('当前不是你的回合')
    expect(notActive.findAll('button').find(button => button.text().includes('抽 1 张'))!.attributes('disabled')).toBeDefined()
  })
})
