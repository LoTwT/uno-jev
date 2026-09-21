// @vitest-environment happy-dom
// K 系（组件）：Jev 设置对话框——来源选择、Key 输入默认隐藏 / 显示切换 / 替换 / 删除、
// 记住开关、费用与存储说明、TypeSafe 官方链接；保存只校验形状，不发验证请求。
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import JevKeySettings from '~/components/game/JevKeySettings.vue'

const KEY = 'ts_personal_key_marker_0123456789abcdef'

function mountSettings(props: Partial<InstanceType<typeof JevKeySettings>['$props']> = {}) {
  return mount(JevKeySettings, {
    props: {
      modelValue: true,
      source: 'site',
      hasKey: false,
      rememberKey: false,
      storageUnavailable: false,
      ...props,
    },
    global: { stubs: { teleport: true } },
  })
}

describe('jevKeySettings', () => {
  it('显示当前来源；站点来源下选中"使用站点额度"', () => {
    const wrapper = mountSettings({ source: 'site' })
    expect(wrapper.text()).toContain('当前使用的来源：站点额度')
    const radios = wrapper.findAll('input[type="radio"]')
    expect(radios).toHaveLength(2)
    expect((radios[0]!.element as HTMLInputElement).checked).toBe(true)
    expect((radios[1]!.element as HTMLInputElement).checked).toBe(false)
  })

  it('切换来源：radio 触发 set-source', async () => {
    const wrapper = mountSettings({ source: 'site' })
    const personalRadio = wrapper.findAll('input[type="radio"]')[1]!
    await personalRadio.setValue()
    expect(wrapper.emitted('setSource')![0]).toEqual(['personal'])
  })

  it('个人来源的费用说明与当前来源显示', () => {
    const wrapper = mountSettings({ source: 'personal', hasKey: true })
    expect(wrapper.text()).toContain('当前使用的来源：你自己的 Key')
    expect(wrapper.text()).toContain('费用由你自己的 TypeSafe 账户承担')
    expect(wrapper.text()).toContain('已配置个人 Key')
  })

  it('key 输入框默认隐藏内容，"显示"切换为明文', async () => {
    const wrapper = mountSettings({ source: 'personal' })
    const input = wrapper.find('input[type="password"]')
    expect(input.exists()).toBe(true)
    await wrapper.findAll('button').find(b => b.text() === '显示')!.trigger('click')
    expect(wrapper.find('input[type="text"]').exists()).toBe(true)
    expect(wrapper.find('input[type="password"]').exists()).toBe(false)
  })

  it('输入 Key 后保存：发出 save-key（去除首尾空白）；空值时按钮禁用', async () => {
    const wrapper = mountSettings({ source: 'personal' })
    const save = wrapper.findAll('button').find(b => b.text().includes('保存 Key'))!
    expect((save.element as HTMLButtonElement).disabled).toBe(true)

    const input = wrapper.find('input[type="password"]')
    await input.setValue(`  ${KEY}  `)
    expect((save.element as HTMLButtonElement).disabled).toBe(false)
    await save.trigger('click')
    expect(wrapper.emitted('saveKey')![0]).toEqual([KEY])
  })

  it('非法输入（空格 Key）：显示错误且不发出 save-key', async () => {
    const wrapper = mountSettings({ source: 'personal' })
    const input = wrapper.find('input[type="password"]')
    await input.setValue('bad key')
    await wrapper.findAll('button').find(b => b.text().includes('保存 Key'))!.trigger('click')
    expect(wrapper.emitted('saveKey')).toBeUndefined()
    expect(wrapper.text()).toContain('Key 只能包含可打印字符')
  })

  it('已配置 Key：提供替换与删除；删除发出 delete-key', async () => {
    const wrapper = mountSettings({ source: 'personal', hasKey: true })
    const del = wrapper.findAll('button').find(b => b.text() === '删除 Key')
    expect(del).toBeDefined()
    await del!.trigger('click')
    expect(wrapper.emitted('deleteKey')).toHaveLength(1)
    // 替换入口：输入框占位符明确"输入新 Key 以替换"
    const input = wrapper.find('input[type="password"]')
    expect(input.attributes('placeholder')).toContain('输入新 Key 以替换')
  })

  it('记住开关：勾选 / 取消发出 set-remember', async () => {
    const wrapper = mountSettings({ source: 'personal', rememberKey: false })
    const checkbox = wrapper.find('input[type="checkbox"]')
    await checkbox.setValue(true)
    expect(wrapper.emitted('setRemember')![0]).toEqual([true])
    await checkbox.setValue(false)
    expect(wrapper.emitted('setRemember')![1]).toEqual([false])
  })

  it('存储说明与官方链接：不宣称加密或绝对安全；不发起验证请求的说明', () => {
    const wrapper = mountSettings({ source: 'personal' })
    const text = wrapper.text()
    expect(text).toContain('在此设备记住')
    expect(text).toContain('不加密，不能视为绝对安全')
    expect(text).toContain('不会保存到本站服务器')
    expect(text).toContain('不会预先发起收费的验证请求')
    const link = wrapper.find('a[href="https://console.typesafe.ai/keys"]')
    expect(link.exists()).toBe(true)
    expect(link.attributes('rel')).toBe('noopener noreferrer')
  })

  it('存储不可用：显示内存模式提示', () => {
    const wrapper = mountSettings({ source: 'personal', storageUnavailable: true })
    expect(wrapper.text()).toContain('Key 仅在本页内存中保留')
  })

  it('替换 Key 写入失败且旧副本仍在：准确提示刷新会恢复旧 Key，提供重试保存', async () => {
    const wrapper = mountSettings({ source: 'personal', hasKey: true, persistProblem: { kind: 'save-failed', staleCopyRemains: true } })
    const text = wrapper.text()
    // 不宣称已删除或只剩内存副本：明确旧副本仍在、刷新恢复旧 Key
    expect(text).toContain('新 Key 已在本页生效')
    expect(text).toContain('此前的已记住副本仍未清除')
    expect(text).toContain('刷新后会恢复并使用旧 Key')
    const retry = wrapper.findAll('button').find(b => b.text() === '重试保存')
    expect(retry).toBeDefined()
    await retry!.trigger('click')
    expect(wrapper.emitted('retryPersist')).toHaveLength(1)
  })

  it('首次保存写入失败（无旧副本）：提示刷新后需重新输入', () => {
    const wrapper = mountSettings({ source: 'personal', persistProblem: { kind: 'save-failed', staleCopyRemains: false } })
    expect(wrapper.text()).toContain('新 Key 已在本页生效')
    expect(wrapper.text()).toContain('刷新后需重新输入')
    expect(wrapper.text()).not.toContain('旧 Key')
  })

  it('删除后清除失败：准确提示刷新仍会恢复该 Key，提供重试清除', async () => {
    const wrapper = mountSettings({ source: 'site', persistProblem: { kind: 'remove-failed' } })
    expect(wrapper.text()).toContain('刷新后该 Key 仍会被恢复')
    const retry = wrapper.findAll('button').find(b => b.text() === '重试清除')
    expect(retry).toBeDefined()
    await retry!.trigger('click')
    expect(wrapper.emitted('retryPersist')).toHaveLength(1)
  })

  it('读取失败（删除）：结果未知提示副本可能仍在，提供重试清除', async () => {
    const wrapper = mountSettings({ source: 'site', persistProblem: { kind: 'storage-error', op: 'delete', staleCopyPossible: true } })
    expect(wrapper.text()).toContain('无法访问本地存储确认结果')
    expect(wrapper.text()).toContain('已记住的副本可能仍在')
    const retry = wrapper.findAll('button').find(b => b.text() === '重试清除')
    expect(retry).toBeDefined()
    await retry!.trigger('click')
    expect(wrapper.emitted('retryPersist')).toHaveLength(1)
  })

  it('读取失败（保存，旧副本可能仍在）：不宣称已保存或只剩内存', () => {
    const wrapper = mountSettings({ source: 'personal', persistProblem: { kind: 'storage-error', op: 'save', staleCopyPossible: true } })
    expect(wrapper.text()).toContain('无法访问本地存储完成保存')
    expect(wrapper.text()).toContain('此前的已记住副本可能仍在')
  })

  it('读取失败（保存，无旧副本）：提示保存结果未知', () => {
    const wrapper = mountSettings({ source: 'personal', persistProblem: { kind: 'storage-error', op: 'save', staleCopyPossible: false } })
    expect(wrapper.text()).toContain('保存结果未知')
    expect(wrapper.text()).toContain('刷新后可能需要重新输入')
  })

  it('外部新 Key 冲突：说明未受影响，不提供重试（重试会误删新 Key）', () => {
    const wrapper = mountSettings({ source: 'site', persistProblem: { kind: 'conflict', op: 'delete' } })
    expect(wrapper.text()).toContain('另一标签页保存了新的 Key')
    expect(wrapper.text()).toContain('该新 Key 的已记住副本未受影响')
    expect(wrapper.findAll('button').find(b => b.text() === '重试保存' || b.text() === '重试清除')).toBeUndefined()
  })

  it('存在持久化问题时不再同时显示"仅内存"提示（避免矛盾说明）', () => {
    const wrapper = mountSettings({ source: 'site', storageUnavailable: true, persistProblem: { kind: 'storage-error', op: 'delete', staleCopyPossible: true } })
    expect(wrapper.text()).toContain('已记住的副本可能仍在')
    expect(wrapper.text()).not.toContain('此浏览器不允许本地保存')
    expect(wrapper.text()).not.toContain('仅在本页内存中保留')
  })
})
