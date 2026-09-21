// @vitest-environment happy-dom
// 问题 8 回归：Jev 暂停后必须显示明确状态与可用的"重试 AI"入口；
// K 系扩展：同时提供"Jev 设置"入口（配置自己的 Key）。
// 组件契约：渲染暂停说明与重试按钮，点击发出 retry（页面接线为 resumeJev）。
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import AiPauseNotice from '~/components/game/AiPauseNotice.vue'

describe('aiPauseNotice（问题 8）', () => {
  it('渲染暂停状态与重试按钮，点击发出 retry', async () => {
    const wrapper = mount(AiPauseNotice, { props: { reason: 'AI 暂不可用' } })
    expect(wrapper.text()).toContain('Jev 暂时不可用')
    expect(wrapper.text()).toContain('规则策略')
    const button = wrapper.findAll('button').find(b => b.text().includes('重试 AI'))
    expect(button, '必须提供重试 AI 入口').toBeDefined()
    await button!.trigger('click')
    expect(wrapper.emitted('retry')).toHaveLength(1)
  })

  it('提供配置自己的 Key 入口：点击发出 open-settings', async () => {
    const wrapper = mount(AiPauseNotice)
    expect(wrapper.text()).toContain('配置自己的 Key')
    const settings = wrapper.findAll('button').find(b => b.text().includes('Jev 设置'))
    expect(settings, '必须提供 Jev 设置入口').toBeDefined()
    await settings!.trigger('click')
    expect(wrapper.emitted('openSettings')).toHaveLength(1)
  })

  it('无障碍：状态区使用 role=status 与 polite 播报', () => {
    const wrapper = mount(AiPauseNotice)
    const status = wrapper.find('[role="status"]')
    expect(status.exists()).toBe(true)
    expect(status.attributes('aria-live')).toBe('polite')
  })
})
