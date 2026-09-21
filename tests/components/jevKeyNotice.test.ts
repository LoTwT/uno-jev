// @vitest-environment happy-dom
// K 系（组件）：Jev 凭据提示条——额度耗尽的持续提示与两个操作、官方 Key 链接、
// Key 被拒归属于个人 Key、缺 Key 的中性提示；确认后由页面隐藏（不重复弹出）。
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import JevKeyNotice from '~/components/game/JevKeyNotice.vue'

describe('jevKeyNotice（额度与凭据引导）', () => {
  it('quota：完整文案、两个操作与官方 Key 链接；保留对局不强制重开', async () => {
    const wrapper = mount(JevKeyNotice, { props: { variant: 'quota' } })
    expect(wrapper.text()).toContain('站点提供的 Jev 额度已用完')
    expect(wrapper.text()).toContain('使用自己的 API Key 继续与 Jev 对战')
    expect(wrapper.text()).toContain('继续使用规则对手')

    const useOwn = wrapper.findAll('button').find(b => b.text() === '使用自己的 Key')
    expect(useOwn).toBeDefined()
    await useOwn!.trigger('click')
    expect(wrapper.emitted('useOwnKey')).toHaveLength(1)

    const dismiss = wrapper.findAll('button').find(b => b.text() === '继续使用规则对手')
    expect(dismiss).toBeDefined()
    await dismiss!.trigger('click')
    expect(wrapper.emitted('dismiss')).toHaveLength(1)

    const link = wrapper.find('a[href="https://console.typesafe.ai/keys"]')
    expect(link.exists()).toBe(true)
    expect(link.attributes('rel')).toBe('noopener noreferrer')
  })

  it('rejected：问题归属于用户自己的 Key，提供修改入口', async () => {
    const wrapper = mount(JevKeyNotice, { props: { variant: 'rejected' } })
    expect(wrapper.text()).toContain('你的 API Key 无效或没有权限')
    expect(wrapper.text()).toContain('Jev 对手暂时使用规则策略')
    const fix = wrapper.findAll('button').find(b => b.text() === '修改 Key')
    expect(fix).toBeDefined()
    await fix!.trigger('click')
    expect(wrapper.emitted('useOwnKey')).toHaveLength(1)
  })

  it('missing：中性提示缺 Key 状态；提供改回站点额度的操作', async () => {
    const wrapper = mount(JevKeyNotice, { props: { variant: 'missing' } })
    expect(wrapper.text()).toContain('尚未输入个人 Key')
    expect(wrapper.text()).toContain('不会消耗站点额度')
    const input = wrapper.findAll('button').find(b => b.text() === '输入 Key')
    expect(input).toBeDefined()
    await input!.trigger('click')
    expect(wrapper.emitted('useOwnKey')).toHaveLength(1)

    const backToSite = wrapper.findAll('button').find(b => b.text() === '改用站点额度')
    expect(backToSite).toBeDefined()
    await backToSite!.trigger('click')
    expect(wrapper.emitted('useSiteQuota')).toHaveLength(1)
  })

  it('无障碍：状态区 role=status 且 polite 播报（持续可见，非 toast）', () => {
    const wrapper = mount(JevKeyNotice, { props: { variant: 'quota' } })
    const status = wrapper.find('[role="status"]')
    expect(status.exists()).toBe(true)
    expect(status.attributes('aria-live')).toBe('polite')
  })
})
