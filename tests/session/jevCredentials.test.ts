// @vitest-environment happy-dom
// K 系（凭据配置）：来源选择、个人 Key 的内存 / 持久化保存与删除、
// 存储不可用回退、持久化内容校验，以及 Key 只存在于独立存储项、不进入其他存储。
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import { useJevCredentials } from '~/composables/useJevCredentials'
import { useVersionedDismissal } from '~/composables/useVersionedDismissal'
import { FakeStorage, installStorage } from './helpers'

const KEY_MARKER = 'ts_personal_key_marker_0123456789abcdef'

function mountCredentials() {
  let exposed!: ReturnType<typeof useJevCredentials>
  const host = defineComponent({
    setup() {
      exposed = useJevCredentials()
      return () => h('div')
    },
  })
  const wrapper = mount(host)
  return { wrapper, credentials: () => exposed }
}

async function settle() {
  await new Promise(resolve => setTimeout(resolve, 0))
}

let restoreStorage: (() => void) | null = null
let fakeStorage: FakeStorage | null = null

beforeEach(() => {
  window.localStorage.clear()
  fakeStorage = new FakeStorage()
  restoreStorage = installStorage(fakeStorage)
})

afterEach(() => {
  restoreStorage?.()
  restoreStorage = null
  fakeStorage = null
})

describe('默认状态与来源选择', () => {
  it('默认使用站点额度：无 Key、不记住、不写任何存储项', async () => {
    const { wrapper, credentials } = mountCredentials()
    await settle()
    expect(credentials().source.value).toBe('site')
    expect(credentials().hasPersonalKey.value).toBe(false)
    expect(credentials().rememberKey.value).toBe(false)
    expect(credentials().credential.value).toEqual({ source: 'site', personalKey: null })
    expect(window.localStorage.length).toBe(0)
    wrapper.unmount()
  })

  it('保存个人 Key 后切换来源：credential 快照跟随变化', async () => {
    const { wrapper, credentials } = mountCredentials()
    await settle()
    credentials().setSource('personal')
    expect(credentials().savePersonalKey(KEY_MARKER)).toEqual({ ok: true })
    expect(credentials().credential.value).toEqual({ source: 'personal', personalKey: KEY_MARKER })
    credentials().setSource('site')
    // 切回站点来源：Key 保留在内存（用户可能切回），来源为站点
    expect(credentials().credential.value).toEqual({ source: 'site', personalKey: KEY_MARKER })
    wrapper.unmount()
  })
})

describe('个人 Key 保存与校验（不发起验证请求）', () => {
  it('未勾选记住：Key 只在内存中，不写入存储', async () => {
    const { wrapper, credentials } = mountCredentials()
    await settle()
    credentials().setSource('personal')
    expect(credentials().savePersonalKey(KEY_MARKER)).toEqual({ ok: true })
    expect(credentials().hasPersonalKey.value).toBe(true)
    expect(window.localStorage.length).toBe(0)
    // credential 快照包含 Key（供调度使用），但公共 API 不暴露 Key 本身
    expect(credentials().credential.value.personalKey).toBe(KEY_MARKER)
    wrapper.unmount()
  })

  it('非法 Key 被拒绝：空值、超长、含空格或换行', async () => {
    const { wrapper, credentials } = mountCredentials()
    await settle()
    expect(credentials().savePersonalKey('   ').ok).toBe(false)
    expect(credentials().savePersonalKey('a'.repeat(257)).ok).toBe(false)
    expect(credentials().savePersonalKey('bad key').ok).toBe(false)
    expect(credentials().savePersonalKey('bad\nkey').ok).toBe(false)
    expect(credentials().hasPersonalKey.value).toBe(false)
    wrapper.unmount()
  })

  it('替换 Key：再次保存覆盖内存值', async () => {
    const { wrapper, credentials } = mountCredentials()
    await settle()
    credentials().savePersonalKey(KEY_MARKER)
    credentials().setRememberKey(true)
    expect(credentials().savePersonalKey('ts_replacement_key_0000000000000001').ok).toBe(true)
    const stored = JSON.parse(window.localStorage.getItem('unojev:jev-key')!)
    expect(stored.key).toBe('ts_replacement_key_0000000000000001')
    wrapper.unmount()
  })
})

describe('记住与删除', () => {
  it('勾选记住：写入独立存储项 unojev:jev-key，包含来源与 Key', async () => {
    const { wrapper, credentials } = mountCredentials()
    await settle()
    credentials().setSource('personal')
    credentials().savePersonalKey(KEY_MARKER)
    credentials().setRememberKey(true)
    expect(JSON.parse(window.localStorage.getItem('unojev:jev-key')!)).toEqual({
      schemaVersion: 1,
      source: 'personal',
      key: KEY_MARKER,
    })
    wrapper.unmount()
  })

  it('记住状态下切换来源：持久化的来源同步更新（刷新后保持最近选择）', async () => {
    const { wrapper, credentials } = mountCredentials()
    await settle()
    credentials().setSource('personal')
    credentials().savePersonalKey(KEY_MARKER)
    credentials().setRememberKey(true)
    credentials().setSource('site')
    expect(JSON.parse(window.localStorage.getItem('unojev:jev-key')!).source).toBe('site')
    wrapper.unmount()
  })

  it('取消记住：删除持久化副本，内存 Key 保留', async () => {
    const { wrapper, credentials } = mountCredentials()
    await settle()
    credentials().setSource('personal')
    credentials().savePersonalKey(KEY_MARKER)
    credentials().setRememberKey(true)
    credentials().setRememberKey(false)
    expect(window.localStorage.getItem('unojev:jev-key')).toBeNull()
    expect(credentials().hasPersonalKey.value).toBe(true)
    expect(credentials().rememberKey.value).toBe(false)
    wrapper.unmount()
  })

  it('删除 Key：同时清除内存与持久化副本（写入墓碑标记），并回到站点额度', async () => {
    const { wrapper, credentials } = mountCredentials()
    await settle()
    credentials().setSource('personal')
    credentials().savePersonalKey(KEY_MARKER)
    credentials().setRememberKey(true)
    credentials().deletePersonalKey()
    expect(credentials().hasPersonalKey.value).toBe(false)
    expect(credentials().source.value).toBe('site')
    expect(credentials().rememberKey.value).toBe(false)
    // 删除写入墓碑标记（不含 Key），供其他标签页区分"删除"与"取消记住"
    expect(JSON.parse(window.localStorage.getItem('unojev:jev-key')!)).toEqual({ schemaVersion: 1, deleted: true })
    expect(window.localStorage.getItem('unojev:jev-key')).not.toContain(KEY_MARKER)
    wrapper.unmount()
  })

  it('记住后新会话恢复：来源、Key 与记住状态从存储还原', async () => {
    window.localStorage.setItem('unojev:jev-key', JSON.stringify({
      schemaVersion: 1,
      source: 'personal',
      key: KEY_MARKER,
    }))
    const { wrapper, credentials } = mountCredentials()
    await settle()
    expect(credentials().source.value).toBe('personal')
    expect(credentials().credential.value).toEqual({ source: 'personal', personalKey: KEY_MARKER })
    expect(credentials().rememberKey.value).toBe(true)
    wrapper.unmount()
  })

  it('持久化内容非法（坏 JSON / 错误版本 / 非法 Key / 未知来源）→ 按默认处理', async () => {
    const badValues = [
      '{oops',
      JSON.stringify({ schemaVersion: 2, source: 'personal', key: KEY_MARKER }),
      JSON.stringify({ schemaVersion: 1, source: 'personal', key: 'bad key' }),
      JSON.stringify({ schemaVersion: 1, source: 'admin', key: KEY_MARKER }),
    ]
    for (const bad of badValues) {
      window.localStorage.setItem('unojev:jev-key', bad)
      const { wrapper, credentials } = mountCredentials()
      await settle()
      expect(credentials().source.value, bad).toBe('site')
      expect(credentials().hasPersonalKey.value, bad).toBe(false)
      // 不覆盖原始槽位内容（与存档策略一致：不静默改写）
      expect(window.localStorage.getItem('unojev:jev-key')).toBe(bad)
      wrapper.unmount()
    }
  })
})

describe('存储不可用与写入失败', () => {
  it('localStorage 访问被禁用：回退内存模式并提示，Key 仍可保存', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage')!
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('denied', 'SecurityError')
      },
    })
    try {
      const { wrapper, credentials } = mountCredentials()
      await settle()
      expect(credentials().storageUnavailable.value).toBe(true)
      credentials().setSource('personal')
      expect(credentials().savePersonalKey(KEY_MARKER)).toEqual({ ok: true })
      credentials().setRememberKey(true)
      expect(credentials().hasPersonalKey.value).toBe(true)
      expect(credentials().storageUnavailable.value).toBe(true)
      wrapper.unmount()
    }
    finally {
      Object.defineProperty(window, 'localStorage', descriptor)
    }
  })

  it('首次记住写入失败（配额等）：新 Key 在本页生效，明确提示且不误称存储不可用', async () => {
    const { wrapper, credentials } = mountCredentials()
    await settle()
    credentials().setSource('personal')
    credentials().savePersonalKey(KEY_MARKER)
    fakeStorage!.failSet = true
    credentials().setRememberKey(true)
    // 新 Key 已在本页生效；持久化失败是可重试的问题，不是"存储不可用"
    expect(credentials().hasPersonalKey.value).toBe(true)
    expect(credentials().rememberKey.value).toBe(true)
    expect(credentials().storageUnavailable.value).toBe(false)
    expect(credentials().persistProblem.value).toEqual({ kind: 'save-failed', staleCopyRemains: false })
    // 恢复后重试成功：问题状态清除，副本写入
    fakeStorage!.failSet = false
    credentials().retryPersist()
    expect(credentials().persistProblem.value).toBeNull()
    expect(JSON.parse(window.localStorage.getItem('unojev:jev-key')!).key).toBe(KEY_MARKER)
    wrapper.unmount()
  })
})

describe('替换 Key 时的持久化失败（问题 2）', () => {
  const REPLACEMENT_KEY = 'ts_replacement_key_0000000000000001'

  async function prepareRememberedKeyA() {
    window.localStorage.setItem('unojev:jev-key', JSON.stringify({
      schemaVersion: 1,
      source: 'personal',
      key: KEY_MARKER,
    }))
    const mounted = mountCredentials()
    await settle()
    return mounted
  }

  it('已记住 A 后替换为 B 且写入失败：B 立即生效，旧副本 A 仍在并被准确提示；重试成功后更新', async () => {
    const { wrapper, credentials } = await prepareRememberedKeyA()
    fakeStorage!.failSet = true
    expect(credentials().savePersonalKey(REPLACEMENT_KEY)).toEqual({ ok: true })
    // 新 Key B 在本页立即生效
    expect(credentials().credential.value).toEqual({ source: 'personal', personalKey: REPLACEMENT_KEY })
    // 旧副本 A 仍残留在存储中：刷新会恢复 A 而不是 B
    expect(JSON.parse(window.localStorage.getItem('unojev:jev-key')!).key).toBe(KEY_MARKER)
    expect(credentials().persistProblem.value).toEqual({ kind: 'save-failed', staleCopyRemains: true })
    expect(credentials().storageUnavailable.value).toBe(false)
    // 重试保存成功：存储更新为 B，问题状态清除
    fakeStorage!.failSet = false
    credentials().retryPersist()
    expect(JSON.parse(window.localStorage.getItem('unojev:jev-key')!).key).toBe(REPLACEMENT_KEY)
    expect(credentials().persistProblem.value).toBeNull()
    wrapper.unmount()
  })

  it('删除时清除失败：提示旧副本仍会随刷新恢复；重试成功后写入墓碑', async () => {
    const { wrapper, credentials } = await prepareRememberedKeyA()
    fakeStorage!.failSet = true
    credentials().deletePersonalKey()
    // 本页已删除，但持久化副本清除失败
    expect(credentials().hasPersonalKey.value).toBe(false)
    expect(credentials().source.value).toBe('site')
    expect(credentials().persistProblem.value).toEqual({ kind: 'remove-failed' })
    expect(JSON.parse(window.localStorage.getItem('unojev:jev-key')!).key).toBe(KEY_MARKER)
    // 重试清除成功：写入墓碑标记
    fakeStorage!.failSet = false
    credentials().retryPersist()
    expect(JSON.parse(window.localStorage.getItem('unojev:jev-key')!)).toEqual({ schemaVersion: 1, deleted: true })
    expect(credentials().persistProblem.value).toBeNull()
    wrapper.unmount()
  })

  it('取消记住时清除失败：内存 Key 保留并提示可重试', async () => {
    const { wrapper, credentials } = await prepareRememberedKeyA()
    fakeStorage!.failRemove = true
    credentials().setRememberKey(false)
    expect(credentials().rememberKey.value).toBe(false)
    expect(credentials().hasPersonalKey.value).toBe(true)
    expect(credentials().persistProblem.value).toEqual({ kind: 'remove-failed' })
    expect(JSON.parse(window.localStorage.getItem('unojev:jev-key')!).key).toBe(KEY_MARKER)
    fakeStorage!.failRemove = false
    credentials().retryPersist()
    expect(window.localStorage.getItem('unojev:jev-key')).toBeNull()
    expect(credentials().persistProblem.value).toBeNull()
    wrapper.unmount()
  })
})

describe('key 的隔离', () => {
  it('key 值只出现在独立存储项中，不进入其他本地存储键（含对局存档槽位）', async () => {
    // 模拟对局存档与其他偏好共存
    window.localStorage.setItem('unojev:save', JSON.stringify({ schemaVersion: 1, savedAt: '2026-09-20T00:00:00Z', writerId: 'w', state: { gameId: 'g', revision: 0 } }))
    window.localStorage.setItem('unojev:theme', '"auto"')
    window.localStorage.setItem('unojev:settings', JSON.stringify({ schemaVersion: 1, reducedMotion: 'system', revealHands: false }))

    const { wrapper, credentials } = mountCredentials()
    await settle()
    credentials().setSource('personal')
    credentials().savePersonalKey(KEY_MARKER)
    credentials().setRememberKey(true)

    const keysWithMarker: string[] = []
    for (let i = 0; i < window.localStorage.length; i++) {
      const storageKey = window.localStorage.key(i)!
      if (window.localStorage.getItem(storageKey)?.includes(KEY_MARKER)) {
        keysWithMarker.push(storageKey)
      }
    }
    expect(keysWithMarker).toEqual(['unojev:jev-key'])
    wrapper.unmount()
  })
})

describe('跨标签页一致性（问题 1）', () => {
  const REPLACEMENT_KEY = 'ts_replacement_key_0000000000000001'

  /** 同一"浏览器"内挂载两个凭据实例（共享 fake storage），模拟两个标签页。 */
  async function mountTwoPages() {
    window.localStorage.setItem('unojev:jev-key', JSON.stringify({
      schemaVersion: 1,
      source: 'personal',
      key: KEY_MARKER,
    }))
    const pageA = mountCredentials()
    const pageB = mountCredentials()
    await settle()
    await settle()
    return { pageA, pageB }
  }

  /** 模拟其他标签页写入后浏览器派发的 storage 事件（两个页面都会收到）。 */
  function fireStorageSync() {
    window.dispatchEvent(new StorageEvent('storage', { key: 'unojev:jev-key' }))
  }

  it('两页均恢复记住的 Key：初始状态一致', async () => {
    const { pageA, pageB } = await mountTwoPages()
    for (const page of [pageA, pageB]) {
      expect(page.credentials().credential.value).toEqual({ source: 'personal', personalKey: KEY_MARKER })
      expect(page.credentials().rememberKey.value).toBe(true)
    }
    pageA.wrapper.unmount()
    pageB.wrapper.unmount()
  })

  it('删除后另一页收到事件：同步删除，切换来源或重新记住都不复活旧 Key', async () => {
    const { pageA, pageB } = await mountTwoPages()
    pageA.credentials().deletePersonalKey()
    fireStorageSync()

    // B 页采纳墓碑：Key 与记住状态清空、回到站点额度
    expect(pageB.credentials().credential.value).toEqual({ source: 'site', personalKey: null })
    expect(pageB.credentials().rememberKey.value).toBe(false)

    // B 页切换来源：无 Key 可持久化，不写回旧 Key
    pageB.credentials().setSource('personal')
    expect(JSON.parse(window.localStorage.getItem('unojev:jev-key')!)).toEqual({ schemaVersion: 1, deleted: true })

    // B 页保存新 Key 并记住：写入的是新 Key，旧 Key 不再出现
    pageB.credentials().savePersonalKey(REPLACEMENT_KEY)
    pageB.credentials().setRememberKey(true)
    expect(JSON.parse(window.localStorage.getItem('unojev:jev-key')!).key).toBe(REPLACEMENT_KEY)
    expect(window.localStorage.getItem('unojev:jev-key')).not.toContain(KEY_MARKER)
    pageA.wrapper.unmount()
    pageB.wrapper.unmount()
  })

  it('替换 Key 后另一页收到事件：采纳新 Key，切换来源不覆盖为旧 Key', async () => {
    const { pageA, pageB } = await mountTwoPages()
    pageA.credentials().savePersonalKey(REPLACEMENT_KEY)
    fireStorageSync()

    // B 页采纳最新凭据（含来源镜像）
    expect(pageB.credentials().credential.value).toEqual({ source: 'personal', personalKey: REPLACEMENT_KEY })
    expect(pageB.credentials().rememberKey.value).toBe(true)

    // B 页切换来源：持久化的是新 Key（旧 Key 不覆盖新 Key）
    pageB.credentials().setSource('site')
    const stored = JSON.parse(window.localStorage.getItem('unojev:jev-key')!)
    expect(stored.key).toBe(REPLACEMENT_KEY)
    expect(stored.source).toBe('site')
    pageA.wrapper.unmount()
    pageB.wrapper.unmount()
  })

  it('未收到事件（竞态）：写前比较发现外部新 Key，采纳后再写，不覆盖', async () => {
    const { pageA, pageB } = await mountTwoPages()
    // A 页替换成功但不派发事件（模拟事件丢失 / 延迟到达）
    pageA.credentials().savePersonalKey(REPLACEMENT_KEY)

    // B 页仍持旧 Key 与旧基线，切换来源触发写前检查
    pageB.credentials().setSource('site')
    // 采纳外部新 Key 后写入：Key 保持为另一页面刚保存的新值
    expect(pageB.credentials().credential.value).toEqual({ source: 'site', personalKey: REPLACEMENT_KEY })
    const stored = JSON.parse(window.localStorage.getItem('unojev:jev-key')!)
    expect(stored.key).toBe(REPLACEMENT_KEY)
    expect(stored.source).toBe('site')
    pageA.wrapper.unmount()
    pageB.wrapper.unmount()
  })

  it('取消记住后另一页收到事件：转为未记住，Key 保留在该页内存', async () => {
    const { pageA, pageB } = await mountTwoPages()
    pageA.credentials().setRememberKey(false)
    fireStorageSync()

    // 条目被移除（区别于墓碑）：B 页保留页内 Key，转为未记住
    expect(window.localStorage.getItem('unojev:jev-key')).toBeNull()
    expect(pageB.credentials().credential.value).toEqual({ source: 'personal', personalKey: KEY_MARKER })
    expect(pageB.credentials().rememberKey.value).toBe(false)
    pageA.wrapper.unmount()
    pageB.wrapper.unmount()
  })

  it('未记住的页内新 Key 保持独立：外部替换不覆盖，随后可按本页意图写入', async () => {
    const { pageA, pageB } = await mountTwoPages()
    // B 页取消记住并输入新 Key（未持久化的页内编辑）
    pageB.credentials().setRememberKey(false)
    pageB.credentials().savePersonalKey(REPLACEMENT_KEY)
    // A 页替换记住的 Key
    pageA.credentials().savePersonalKey('ts_page_a_new_key_00000000000002')
    fireStorageSync()

    // B 页的页内新 Key 不被外部同步覆盖
    expect(pageB.credentials().credential.value.personalKey).toBe(REPLACEMENT_KEY)
    // B 页随后勾选记住：按本页最新意图写入
    pageB.credentials().setRememberKey(true)
    expect(JSON.parse(window.localStorage.getItem('unojev:jev-key')!).key).toBe(REPLACEMENT_KEY)
    pageA.wrapper.unmount()
    pageB.wrapper.unmount()
  })

  it('删除事件到达仍有未保存新 Key 的页面：保留页内新 Key，持久化时不写回旧 Key', async () => {
    const { pageA, pageB } = await mountTwoPages()
    pageB.credentials().setRememberKey(false)
    pageB.credentials().savePersonalKey(REPLACEMENT_KEY)
    pageA.credentials().deletePersonalKey()
    fireStorageSync()

    // 页内新 Key 保留；随后记住写入的是新 Key（不是被删除的旧 Key）
    expect(pageB.credentials().credential.value.personalKey).toBe(REPLACEMENT_KEY)
    pageB.credentials().setRememberKey(true)
    expect(JSON.parse(window.localStorage.getItem('unojev:jev-key')!).key).toBe(REPLACEMENT_KEY)
    pageA.wrapper.unmount()
    pageB.wrapper.unmount()
  })

  it('墓碑标记的新会话：按无记住 Key 处理，重新记住可写入新 Key', async () => {
    window.localStorage.setItem('unojev:jev-key', JSON.stringify({ schemaVersion: 1, deleted: true }))
    const { wrapper, credentials } = mountCredentials()
    await settle()
    expect(credentials().source.value).toBe('site')
    expect(credentials().hasPersonalKey.value).toBe(false)
    expect(credentials().rememberKey.value).toBe(false)
    credentials().setSource('personal')
    credentials().savePersonalKey(REPLACEMENT_KEY)
    credentials().setRememberKey(true)
    expect(JSON.parse(window.localStorage.getItem('unojev:jev-key')!).key).toBe(REPLACEMENT_KEY)
    wrapper.unmount()
  })

  it('bfcache 恢复重同步：缓存期间另一页删除，恢复后按当前存储状态收敛', async () => {
    const { pageA, pageB } = await mountTwoPages()
    pageA.credentials().deletePersonalKey()
    // B 页在 bfcache 中未收到事件；恢复后主动重同步
    pageB.credentials().resyncFromStorage()
    expect(pageB.credentials().credential.value).toEqual({ source: 'site', personalKey: null })
    expect(pageB.credentials().rememberKey.value).toBe(false)
    pageA.wrapper.unmount()
    pageB.wrapper.unmount()
  })

  it('取消记住后旧页未收到事件就切换来源：不写回 Key；显式重新记住仍可保存', async () => {
    const { pageA, pageB } = await mountTwoPages()
    pageA.credentials().setRememberKey(false)
    // B 页未收到事件（不派发）就切换来源：附带的保存不得把已取消记住的 Key 写回
    pageB.credentials().setSource('site')
    expect(window.localStorage.getItem('unojev:jev-key')).toBeNull()
    expect(pageB.credentials().rememberKey.value).toBe(false)
    expect(pageB.credentials().credential.value).toEqual({ source: 'site', personalKey: KEY_MARKER })
    expect(pageB.credentials().persistProblem.value).toBeNull()
    // 用户随后显式勾选记住：仍能正常保存当前 Key
    pageB.credentials().setRememberKey(true)
    expect(JSON.parse(window.localStorage.getItem('unojev:jev-key')!)).toEqual({
      schemaVersion: 1,
      source: 'site',
      key: KEY_MARKER,
    })
    pageA.wrapper.unmount()
    pageB.wrapper.unmount()
  })

  it('外部仅改变来源时删除：仍清除同一个 Key 并通过墓碑同步', async () => {
    const { pageA, pageB } = await mountTwoPages()
    // B 切换来源（同一个 Key），A 未收到事件
    pageB.credentials().setSource('site')
    expect(JSON.parse(window.localStorage.getItem('unojev:jev-key')!).key).toBe(KEY_MARKER)
    // A 删除：仍清除该 Key（来源变化不构成冲突），写入墓碑
    pageA.credentials().deletePersonalKey()
    expect(JSON.parse(window.localStorage.getItem('unojev:jev-key')!)).toEqual({ schemaVersion: 1, deleted: true })
    expect(pageA.credentials().persistProblem.value).toBeNull()
    // 墓碑同步到 B：Key 与记住状态清空
    fireStorageSync()
    expect(pageB.credentials().credential.value).toEqual({ source: 'site', personalKey: null })
    pageA.wrapper.unmount()
    pageB.wrapper.unmount()
  })

  it('外部仅改变来源时取消记住：仍移除该 Key', async () => {
    const { pageA, pageB } = await mountTwoPages()
    pageB.credentials().setSource('site')
    pageA.credentials().setRememberKey(false)
    expect(window.localStorage.getItem('unojev:jev-key')).toBeNull()
    expect(pageA.credentials().persistProblem.value).toBeNull()
    pageA.wrapper.unmount()
    pageB.wrapper.unmount()
  })

  it('外部保存了新 Key 时删除：不误删新凭据，报告冲突且无可重试清除', async () => {
    const { pageA, pageB } = await mountTwoPages()
    pageB.credentials().savePersonalKey(REPLACEMENT_KEY)
    // A 未收到事件就删除：不得误删另一页刚保存的新 Key，也不能虚报清除成功
    pageA.credentials().deletePersonalKey()
    expect(JSON.parse(window.localStorage.getItem('unojev:jev-key')!).key).toBe(REPLACEMENT_KEY)
    expect(pageA.credentials().hasPersonalKey.value).toBe(false)
    expect(pageA.credentials().persistProblem.value).toEqual({ kind: 'conflict', op: 'delete' })
    // 冲突没有可重试动作：重试不会删掉新 Key
    pageA.credentials().retryPersist()
    expect(JSON.parse(window.localStorage.getItem('unojev:jev-key')!).key).toBe(REPLACEMENT_KEY)
    pageA.wrapper.unmount()
    pageB.wrapper.unmount()
  })

  it('外部保存了新 Key 时取消记住：同样受冲突保护', async () => {
    const { pageA, pageB } = await mountTwoPages()
    pageB.credentials().savePersonalKey(REPLACEMENT_KEY)
    pageA.credentials().setRememberKey(false)
    expect(JSON.parse(window.localStorage.getItem('unojev:jev-key')!).key).toBe(REPLACEMENT_KEY)
    expect(pageA.credentials().rememberKey.value).toBe(false)
    expect(pageA.credentials().persistProblem.value).toEqual({ kind: 'conflict', op: 'unremember' })
    pageA.wrapper.unmount()
    pageB.wrapper.unmount()
  })
})

describe('个人 Key 版本与提示确认（问题 3）', () => {
  it('个人 Key 保存 / 替换 / 删除与跨页同步都会递增版本；切换来源不递增', async () => {
    window.localStorage.setItem('unojev:jev-key', JSON.stringify({
      schemaVersion: 1,
      source: 'personal',
      key: KEY_MARKER,
    }))
    const { wrapper, credentials } = mountCredentials()
    await settle()
    // 挂载恢复已记住的 Key：版本从 0 递增到 1
    expect(credentials().personalKeyVersion.value).toBe(1)
    credentials().setSource('site')
    expect(credentials().personalKeyVersion.value).toBe(1)
    credentials().savePersonalKey('ts_new_key_0000000000000000001')
    expect(credentials().personalKeyVersion.value).toBe(2)
    credentials().deletePersonalKey()
    expect(credentials().personalKeyVersion.value).toBe(3)
    wrapper.unmount()
  })

  it('新 Key 替换后，旧 Key 的"无法使用"确认不再抑制提示（集成 useVersionedDismissal）', async () => {
    window.localStorage.setItem('unojev:jev-key', JSON.stringify({
      schemaVersion: 1,
      source: 'personal',
      key: KEY_MARKER,
    }))
    let exposed!: ReturnType<typeof useJevCredentials>
    let dismissal!: ReturnType<typeof useVersionedDismissal>
    const host = defineComponent({
      setup() {
        exposed = useJevCredentials()
        dismissal = useVersionedDismissal(exposed.personalKeyVersion)
        return () => h('div')
      },
    })
    const wrapper = mount(host)
    await settle()

    // Key A 被拒绝后用户关闭提示（记录当前版本）
    dismissal.dismiss()
    expect(dismissal.dismissed.value).toBe(true)

    // 替换为 Key B：版本递增，旧确认不再抑制——新 Key 被拒绝时提示会再次显示
    exposed.savePersonalKey('ts_replacement_key_0000000000000001')
    expect(dismissal.dismissed.value).toBe(false)

    // 同一 Key B 再次失败：确认后保持抑制（不逐回合打扰）
    dismissal.dismiss()
    expect(dismissal.dismissed.value).toBe(true)
    wrapper.unmount()
  })
})

describe('存储读取失败时的操作意图与重试（问题 3）', () => {
  const REPLACEMENT_KEY = 'ts_replacement_key_0000000000000001'

  /** 挂载一个已恢复记住 KEY_MARKER 的页面。 */
  async function mountRememberedPage() {
    window.localStorage.setItem('unojev:jev-key', JSON.stringify({
      schemaVersion: 1,
      source: 'personal',
      key: KEY_MARKER,
    }))
    const mounted = mountCredentials()
    await settle()
    return mounted
  }

  it('删除前读取失败：保留删除意图与准确提示，存储恢复后重试成功清除', async () => {
    const { wrapper, credentials } = await mountRememberedPage()
    fakeStorage!.failGet = true
    credentials().deletePersonalKey()
    // 本页已删除；读取失败不代表副本不存在，不得误称只剩内存
    expect(credentials().hasPersonalKey.value).toBe(false)
    expect(credentials().source.value).toBe('site')
    expect(credentials().storageUnavailable.value).toBe(true)
    expect(credentials().persistProblem.value).toEqual({ kind: 'storage-error', op: 'delete', staleCopyPossible: true })

    // 存储中的旧副本原样保留（读取失败不影响真实存储内容）
    fakeStorage!.failGet = false
    expect(JSON.parse(window.localStorage.getItem('unojev:jev-key')!).key).toBe(KEY_MARKER)

    // 权限未恢复时重试仍失败；恢复后重试成功写入墓碑，并更新两个状态
    fakeStorage!.failGet = true
    credentials().retryPersist()
    expect(credentials().persistProblem.value).toEqual({ kind: 'storage-error', op: 'delete', staleCopyPossible: true })
    fakeStorage!.failGet = false
    credentials().retryPersist()
    expect(JSON.parse(window.localStorage.getItem('unojev:jev-key')!)).toEqual({ schemaVersion: 1, deleted: true })
    expect(credentials().persistProblem.value).toBeNull()
    expect(credentials().storageUnavailable.value).toBe(false)
    wrapper.unmount()
  })

  it('取消记住前读取失败：重试后正常清除', async () => {
    const { wrapper, credentials } = await mountRememberedPage()
    fakeStorage!.failGet = true
    credentials().setRememberKey(false)
    expect(credentials().rememberKey.value).toBe(false)
    expect(credentials().hasPersonalKey.value).toBe(true)
    expect(credentials().persistProblem.value).toEqual({ kind: 'storage-error', op: 'unremember', staleCopyPossible: true })

    fakeStorage!.failGet = false
    expect(JSON.parse(window.localStorage.getItem('unojev:jev-key')!).key).toBe(KEY_MARKER)
    credentials().retryPersist()
    expect(window.localStorage.getItem('unojev:jev-key')).toBeNull()
    expect(credentials().persistProblem.value).toBeNull()
    expect(credentials().storageUnavailable.value).toBe(false)
    wrapper.unmount()
  })

  it('替换 Key 时读取失败：新 Key 生效，提示旧副本可能仍在；恢复后重试写入', async () => {
    const { wrapper, credentials } = await mountRememberedPage()
    fakeStorage!.failGet = true
    expect(credentials().savePersonalKey(REPLACEMENT_KEY)).toEqual({ ok: true })
    expect(credentials().credential.value).toEqual({ source: 'personal', personalKey: REPLACEMENT_KEY })
    expect(credentials().persistProblem.value).toEqual({ kind: 'storage-error', op: 'save', staleCopyPossible: true })

    fakeStorage!.failGet = false
    expect(JSON.parse(window.localStorage.getItem('unojev:jev-key')!).key).toBe(KEY_MARKER)
    credentials().retryPersist()
    expect(JSON.parse(window.localStorage.getItem('unojev:jev-key')!).key).toBe(REPLACEMENT_KEY)
    expect(credentials().persistProblem.value).toBeNull()
    expect(credentials().storageUnavailable.value).toBe(false)
    wrapper.unmount()
  })

  it('首次记住时读取失败：提示保存结果未知（无旧副本），不误称已保存', async () => {
    const { wrapper, credentials } = mountCredentials()
    await settle()
    credentials().setSource('personal')
    credentials().savePersonalKey(KEY_MARKER)
    fakeStorage!.failGet = true
    credentials().setRememberKey(true)
    expect(credentials().persistProblem.value).toEqual({ kind: 'storage-error', op: 'save', staleCopyPossible: false })

    fakeStorage!.failGet = false
    credentials().retryPersist()
    expect(JSON.parse(window.localStorage.getItem('unojev:jev-key')!).key).toBe(KEY_MARKER)
    expect(credentials().persistProblem.value).toBeNull()
    wrapper.unmount()
  })

  it('重试期间外部保存了新 Key：过期删除意图不误删，转为冲突提示', async () => {
    const { wrapper, credentials } = await mountRememberedPage()
    fakeStorage!.failSet = true
    credentials().deletePersonalKey()
    expect(credentials().persistProblem.value).toEqual({ kind: 'remove-failed' })

    // 模拟另一页面在重试前保存了新 Key（直接写存储）
    fakeStorage!.failSet = false
    window.localStorage.setItem('unojev:jev-key', JSON.stringify({
      schemaVersion: 1,
      source: 'personal',
      key: REPLACEMENT_KEY,
    }))
    credentials().retryPersist()
    // 过期意图针对旧 Key：不删除新 Key，转为冲突提示
    expect(JSON.parse(window.localStorage.getItem('unojev:jev-key')!).key).toBe(REPLACEMENT_KEY)
    expect(credentials().persistProblem.value).toEqual({ kind: 'conflict', op: 'delete' })
    wrapper.unmount()
  })

  it('外部已删除（墓碑）时重试取消记住：不移除墓碑', async () => {
    const { wrapper, credentials } = await mountRememberedPage()
    fakeStorage!.failRemove = true
    credentials().setRememberKey(false)
    expect(credentials().persistProblem.value).toEqual({ kind: 'remove-failed' })

    // 另一页面已删除（写入墓碑）
    fakeStorage!.failRemove = false
    window.localStorage.setItem('unojev:jev-key', JSON.stringify({ schemaVersion: 1, deleted: true }))
    credentials().retryPersist()
    // 取消记住不得把墓碑降级移除
    expect(JSON.parse(window.localStorage.getItem('unojev:jev-key')!)).toEqual({ schemaVersion: 1, deleted: true })
    expect(credentials().persistProblem.value).toBeNull()
    wrapper.unmount()
  })

  it('新的用户操作成功后不再保留过期重试意图', async () => {
    const { wrapper, credentials } = await mountRememberedPage()
    fakeStorage!.failSet = true
    credentials().deletePersonalKey()
    expect(credentials().persistProblem.value).toEqual({ kind: 'remove-failed' })

    // 用户改为保存新 Key 并显式记住：新操作覆盖旧意图并成功
    fakeStorage!.failSet = false
    credentials().savePersonalKey(REPLACEMENT_KEY)
    credentials().setRememberKey(true)
    expect(credentials().persistProblem.value).toBeNull()
    expect(JSON.parse(window.localStorage.getItem('unojev:jev-key')!).key).toBe(REPLACEMENT_KEY)

    // 此后重试无待办意图，不会意外触发旧清除
    credentials().retryPersist()
    expect(JSON.parse(window.localStorage.getItem('unojev:jev-key')!).key).toBe(REPLACEMENT_KEY)
    wrapper.unmount()
  })
})

describe('清除意图的判定目标（P2：删除重试误判本页旧副本）', () => {
  const REPLACEMENT_KEY = 'ts_replacement_key_0000000000000001'
  const EXTERNAL_NEW_KEY = 'ts_external_new_key_0000000000003'

  /** 挂载一个已恢复记住 KEY_MARKER 的页面（挂载基线 origin 为 own）。 */
  async function mountRememberedPage() {
    window.localStorage.setItem('unojev:jev-key', JSON.stringify({
      schemaVersion: 1,
      source: 'personal',
      key: KEY_MARKER,
    }))
    const mounted = mountCredentials()
    await settle()
    return mounted
  }

  it('读取故障期间替换 B 并删除：恢复后重试按本页遗留副本清除 A，不误判为外部冲突', async () => {
    const { wrapper, credentials } = await mountRememberedPage()
    fakeStorage!.failGet = true
    expect(credentials().savePersonalKey(REPLACEMENT_KEY)).toEqual({ ok: true })
    credentials().deletePersonalKey()
    // 内存 Key 已清空；读取失败不代表副本不存在，删除意图保留
    // （判定目标 = 页内 B + 本页基线 A）
    expect(credentials().hasPersonalKey.value).toBe(false)
    expect(credentials().source.value).toBe('site')
    expect(credentials().persistProblem.value).toEqual({ kind: 'storage-error', op: 'delete', staleCopyPossible: true })

    // 恢复访问：存储实际仍是本页遗留的旧副本 A（未被 B 覆盖）
    fakeStorage!.failGet = false
    expect(JSON.parse(window.localStorage.getItem('unojev:jev-key')!).key).toBe(KEY_MARKER)
    credentials().retryPersist()
    // A 属于本次清除的判定目标（本页自己的基线副本）：正常清除并写入墓碑，
    // 而不是被误判为"其他标签页的新 Key"而卡在冲突里
    expect(JSON.parse(window.localStorage.getItem('unojev:jev-key')!)).toEqual({ schemaVersion: 1, deleted: true })
    expect(window.localStorage.getItem('unojev:jev-key')).not.toContain(KEY_MARKER)
    expect(credentials().persistProblem.value).toBeNull()
    expect(credentials().storageUnavailable.value).toBe(false)
    // 重复重试不执行已完成的操作
    credentials().retryPersist()
    expect(JSON.parse(window.localStorage.getItem('unojev:jev-key')!)).toEqual({ schemaVersion: 1, deleted: true })
    expect(credentials().persistProblem.value).toBeNull()
    wrapper.unmount()
  })

  it('写入失败留下旧副本 A 后删除：重试成功清除（页内 B ≠ 基线 A）', async () => {
    const { wrapper, credentials } = await mountRememberedPage()
    fakeStorage!.failSet = true
    expect(credentials().savePersonalKey(REPLACEMENT_KEY)).toEqual({ ok: true })
    expect(credentials().persistProblem.value).toEqual({ kind: 'save-failed', staleCopyRemains: true })
    credentials().deletePersonalKey()
    // 本页已删除；墓碑写入失败，旧副本 A 仍在存储中
    expect(credentials().persistProblem.value).toEqual({ kind: 'remove-failed' })
    expect(JSON.parse(window.localStorage.getItem('unojev:jev-key')!).key).toBe(KEY_MARKER)

    fakeStorage!.failSet = false
    credentials().retryPersist()
    // 重试与首次执行共用判定目标：本页基线 A 可被清除
    expect(JSON.parse(window.localStorage.getItem('unojev:jev-key')!)).toEqual({ schemaVersion: 1, deleted: true })
    expect(credentials().persistProblem.value).toBeNull()
    wrapper.unmount()
  })

  it('读取故障期间替换 B 并取消记住：恢复后重试清除遗留的 A', async () => {
    const { wrapper, credentials } = await mountRememberedPage()
    fakeStorage!.failGet = true
    expect(credentials().savePersonalKey(REPLACEMENT_KEY)).toEqual({ ok: true })
    credentials().setRememberKey(false)
    expect(credentials().rememberKey.value).toBe(false)
    expect(credentials().hasPersonalKey.value).toBe(true)
    expect(credentials().persistProblem.value).toEqual({ kind: 'storage-error', op: 'unremember', staleCopyPossible: true })

    fakeStorage!.failGet = false
    credentials().retryPersist()
    expect(window.localStorage.getItem('unojev:jev-key')).toBeNull()
    expect(credentials().persistProblem.value).toBeNull()
    expect(credentials().storageUnavailable.value).toBe(false)
    wrapper.unmount()
  })

  it('重试前外部换成新 Key C：不误删 C，转为冲突且重复重试无动作', async () => {
    const { wrapper, credentials } = await mountRememberedPage()
    fakeStorage!.failGet = true
    credentials().savePersonalKey(REPLACEMENT_KEY)
    credentials().deletePersonalKey()
    fakeStorage!.failGet = false
    // 另一标签页在重试前保存了新 Key C（本页未收到事件）
    window.localStorage.setItem('unojev:jev-key', JSON.stringify({
      schemaVersion: 1,
      source: 'personal',
      key: EXTERNAL_NEW_KEY,
    }))
    credentials().retryPersist()
    // C 不属于本次清除意图：保护新凭据，如实报告冲突
    expect(JSON.parse(window.localStorage.getItem('unojev:jev-key')!).key).toBe(EXTERNAL_NEW_KEY)
    expect(credentials().persistProblem.value).toEqual({ kind: 'conflict', op: 'delete' })
    // 冲突无可重试动作：重复重试不会删掉 C
    credentials().retryPersist()
    expect(JSON.parse(window.localStorage.getItem('unojev:jev-key')!).key).toBe(EXTERNAL_NEW_KEY)
    expect(credentials().persistProblem.value).toEqual({ kind: 'conflict', op: 'delete' })
    wrapper.unmount()
  })

  it('重试前外部仅改变同一 Key 的来源：仍按判定目标清除', async () => {
    const { wrapper, credentials } = await mountRememberedPage()
    fakeStorage!.failGet = true
    credentials().savePersonalKey(REPLACEMENT_KEY)
    credentials().deletePersonalKey()
    fakeStorage!.failGet = false
    // 另一标签页仅切换了同一 Key A 的来源（本页未收到事件）
    window.localStorage.setItem('unojev:jev-key', JSON.stringify({
      schemaVersion: 1,
      source: 'site',
      key: KEY_MARKER,
    }))
    credentials().retryPersist()
    // 来源变化不改变"A 是本页遗留的待清除副本"：照常清除并写入墓碑
    expect(JSON.parse(window.localStorage.getItem('unojev:jev-key')!)).toEqual({ schemaVersion: 1, deleted: true })
    expect(credentials().persistProblem.value).toBeNull()
    wrapper.unmount()
  })
})

describe('保存意图的过期与重试（P2：附带保存撤销已同步的取消记住）', () => {
  /** 同一"浏览器"内挂载两个凭据实例（共享 fake storage），模拟两个标签页。 */
  async function mountTwoPages() {
    window.localStorage.setItem('unojev:jev-key', JSON.stringify({
      schemaVersion: 1,
      source: 'personal',
      key: KEY_MARKER,
    }))
    const pageA = mountCredentials()
    const pageB = mountCredentials()
    await settle()
    await settle()
    return { pageA, pageB }
  }

  /** 模拟其他标签页写入后浏览器派发的 storage 事件（两个页面都会收到）。 */
  function fireStorageSync() {
    window.dispatchEvent(new StorageEvent('storage', { key: 'unojev:jev-key' }))
  }

  it('附带保存失败后另一页取消记住：事件送达即清除过期意图与提示，重试不写回 Key；重新勾选可保存', async () => {
    const { pageA, pageB } = await mountTwoPages()
    // B 切换来源触发附带保存，写入失败，留下待重试的保存意图
    fakeStorage!.failSet = true
    pageB.credentials().setSource('site')
    expect(pageB.credentials().persistProblem.value).toEqual({ kind: 'save-failed', staleCopyRemains: false })
    expect(pageB.credentials().rememberKey.value).toBe(true)

    // A 取消记住；B 收到 storage 事件（lastStored 同步为空、rememberKey 变为 false）
    fakeStorage!.failSet = false
    pageA.credentials().setRememberKey(false)
    fireStorageSync()
    expect(window.localStorage.getItem('unojev:jev-key')).toBeNull()
    expect(pageB.credentials().rememberKey.value).toBe(false)
    expect(pageB.credentials().credential.value).toEqual({ source: 'site', personalKey: KEY_MARKER })
    // 过期的附带保存意图与提示被清除：重试入口消失
    expect(pageB.credentials().persistProblem.value).toBeNull()

    // 即便再次触发重试，也不会把 Key 写回存储（复选框仍显示未记住）
    pageB.credentials().retryPersist()
    expect(window.localStorage.getItem('unojev:jev-key')).toBeNull()
    expect(pageB.credentials().rememberKey.value).toBe(false)
    expect(pageB.credentials().persistProblem.value).toBeNull()

    // 用户重新显式勾选记住：正常保存当前 Key
    pageB.credentials().setRememberKey(true)
    expect(JSON.parse(window.localStorage.getItem('unojev:jev-key')!)).toEqual({
      schemaVersion: 1,
      source: 'site',
      key: KEY_MARKER,
    })
    expect(pageB.credentials().rememberKey.value).toBe(true)
    expect(pageB.credentials().persistProblem.value).toBeNull()
    pageA.wrapper.unmount()
    pageB.wrapper.unmount()
  })

  it('附带保存失败后另一页删除（墓碑）：过期保存意图同样被清除，重试不复活 Key', async () => {
    const { pageA, pageB } = await mountTwoPages()
    fakeStorage!.failSet = true
    pageB.credentials().setSource('site')
    expect(pageB.credentials().persistProblem.value).toEqual({ kind: 'save-failed', staleCopyRemains: false })

    fakeStorage!.failSet = false
    pageA.credentials().deletePersonalKey()
    fireStorageSync()
    // B 采纳墓碑：Key 与记住状态清空；过期的保存意图与提示被清除
    expect(JSON.parse(window.localStorage.getItem('unojev:jev-key')!)).toEqual({ schemaVersion: 1, deleted: true })
    expect(pageB.credentials().credential.value).toEqual({ source: 'site', personalKey: null })
    expect(pageB.credentials().rememberKey.value).toBe(false)
    expect(pageB.credentials().persistProblem.value).toBeNull()

    pageB.credentials().retryPersist()
    expect(JSON.parse(window.localStorage.getItem('unojev:jev-key')!)).toEqual({ schemaVersion: 1, deleted: true })
    expect(window.localStorage.getItem('unojev:jev-key')).not.toContain(KEY_MARKER)
    pageA.wrapper.unmount()
    pageB.wrapper.unmount()
  })

  it('显式记住的保存意图在另一页取消记住生效后同样过期：不写回，重新勾选可保存', async () => {
    const { pageA, pageB } = await mountTwoPages()
    // B 先取消记住（条目移除），A 未收到事件并重新保存同一 Key（恢复存储条目）
    pageB.credentials().setRememberKey(false)
    pageA.credentials().savePersonalKey(KEY_MARKER)
    expect(JSON.parse(window.localStorage.getItem('unojev:jev-key')!).key).toBe(KEY_MARKER)
    // B 显式重新勾选记住：保存因写入失败待重试
    fakeStorage!.failSet = true
    pageB.credentials().setRememberKey(true)
    expect(pageB.credentials().persistProblem.value).toEqual({ kind: 'save-failed', staleCopyRemains: false })
    expect(pageB.credentials().rememberKey.value).toBe(true)

    // A 在 B 的显式保存失败之后取消记住（真实的外部移除转换）
    fakeStorage!.failSet = false
    pageA.credentials().setRememberKey(false)
    fireStorageSync()
    // B 同步为未记住：过期的显式保存意图与提示被清除，Key 不写回
    expect(window.localStorage.getItem('unojev:jev-key')).toBeNull()
    expect(pageB.credentials().rememberKey.value).toBe(false)
    expect(pageB.credentials().hasPersonalKey.value).toBe(true)
    expect(pageB.credentials().persistProblem.value).toBeNull()

    pageB.credentials().retryPersist()
    expect(window.localStorage.getItem('unojev:jev-key')).toBeNull()
    expect(pageB.credentials().rememberKey.value).toBe(false)

    // 用户再次显式勾选记住：正常保存
    pageB.credentials().setRememberKey(true)
    expect(JSON.parse(window.localStorage.getItem('unojev:jev-key')!)).toEqual({
      schemaVersion: 1,
      source: 'personal',
      key: KEY_MARKER,
    })
    expect(pageB.credentials().persistProblem.value).toBeNull()
    pageA.wrapper.unmount()
    pageB.wrapper.unmount()
  })
})
