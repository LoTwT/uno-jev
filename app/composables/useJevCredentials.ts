import type { AiCredentialSource } from '#shared/ai/protocol'
/**
 * Jev 凭据配置：站点额度 / 个人 Key 的来源选择、Key 的内存与持久化保存。
 *
 * - 默认使用站点额度；个人 Key 默认只保留在当前页面内存，刷新后需重新输入。
 * - 用户主动勾选"在此设备记住"后才写入独立存储项 unojev:jev-key（仅浏览器本地，
 *   不加密、不宣称绝对安全；不保存到本站服务器）。
 * - Key 只经同源 HTTPS 请求的专用请求头传给本站 Worker；不进入游戏存档、
 *   公开事件、SSR 数据、URL、日志或错误响应。
 *
 * 跨标签页一致性（存储项是"已记住凭据"的唯一共享事实来源）：
 * - 删除写入墓碑标记 `{ schemaVersion: 1, deleted: true }`（不含 Key），让其他
 *   标签页区分"删除"与"取消记住"（后者仅移除条目、Key 留在各页内存）。
 * - 通过 storage 事件与写前比较（CAS）同步：旧页面不复活已删除的 Key，
 *   也不覆盖另一页面刚保存的新 Key；本页未持久化的新 Key（输入或替换后
 *   写入失败 / 未记住）保持独立，不被外部同步覆盖。
 * - 附带保存（切换来源 / 保存 Key 时的持久化）与显式勾选记住区分：每次实际
 *   保存前（含重试路径）检查当前有效的保存意图——外部取消记住经同步生效后，
 *   过期的保存意图不再把 Key 写回（待重试操作与提示一并清除）；显式勾选
 *   记住的意图仍优先并正常保存。
 * - 清除意图在创建时记录判定目标（本次操作针对的页内 Key + 本页自己的存储
 *   基线副本，如替换写入失败遗留的旧 Key），首次执行与重试共用同一判定：
 *   外部仅改变同一 Key 的来源时照常清除；外部保存了不同的新 Key 时不误删、
 *   不虚报成功，报告冲突（无可重试动作）。
 * - 同步导致当前有效凭据变化时，经 credential 快照触发既有的请求失效与重调度。
 *
 * 持久化失败与存储不可用是两类状态：写入 / 清除失败给出准确的问题描述（旧副本
 * 是否残留）与重试入口；读取失败不代表副本不存在——保留具体操作意图（保存 /
 * 取消记住 / 删除及判定目标），结果未知时如实提示，恢复访问后重试，成功后同时
 * 更新问题与可用状态；localStorage 不可访问才是"仅本页内存"模式。删除 Key 同时
 * 清除内存与持久化副本。
 */
import { computed, onBeforeUnmount, onMounted, readonly, ref, watch } from 'vue'
import { AI_PERSONAL_KEY_MAX_LENGTH, AI_PERSONAL_KEY_PATTERN } from '#shared/ai/protocol'
import { localStorageAccessible } from '~/utils/storage'

export const JEV_KEY_STORAGE_KEY = 'unojev:jev-key'

/** 经核实的 TypeSafe 官方 Key 获取入口（2026-09-20 核对 quickstart 文档）。 */
export const TYPESAFE_KEYS_URL = 'https://console.typesafe.ai/keys'

/** 传给 AI 调度的凭据快照；personalKey 仅在来源为 personal 时有意义。 */
export interface JevCredential {
  source: AiCredentialSource
  personalKey: string | null
}

/** 个人 Key 校验结果；失败时给出可直接展示的中文原因。 */
export type PersonalKeySaveResult = { ok: true } | { ok: false, message: string }

/**
 * 持久化问题的准确状态（区别于存储完全不可用的"仅内存"模式）。
 * - save-failed：新 Key 已在本页生效，但写入本地存储失败；staleCopyRemains
 *   表示此前的已记住旧副本仍未清除（刷新会恢复旧 Key 而不是新 Key）。
 * - remove-failed：删除 / 取消记住已在本页生效，但本地存储中的副本清除失败
 *   （刷新后该 Key 仍会被恢复）。
 * - storage-error：无法访问本地存储，操作结果未知——读取失败不代表持久化
 *   副本不存在；staleCopyPossible 表示旧副本可能仍会随刷新恢复。保留具体
 *   操作意图（op），恢复访问后可重试。
 * - conflict：另一标签页保存了新的 Key，本页的清除未影响它——不得误删新凭据，
 *   也不能虚报清除成功；没有可重试的动作。
 */
export type JevKeyPersistProblem
  = | { kind: 'save-failed', staleCopyRemains: boolean }
    | { kind: 'remove-failed' }
    | { kind: 'storage-error', op: 'save' | 'unremember' | 'delete', staleCopyPossible: boolean }
    | { kind: 'conflict', op: 'unremember' | 'delete' }

/** 已记住的凭据（含来源选择）；删除时写入墓碑标记。 */
interface StoredCredential {
  schemaVersion: 1
  source: AiCredentialSource
  key: string
}

interface StoredTombstone {
  schemaVersion: 1
  deleted: true
}

type StoredValue = StoredCredential | StoredTombstone

const CREDENTIAL_SOURCE_VALUES: AiCredentialSource[] = ['site', 'personal']

/** 校验个人 Key 形状（可打印 ASCII、长度上限）；不预设具体 Key 格式，也不验证有效性。 */
export function validatePersonalKeyShape(rawKey: string): PersonalKeySaveResult {
  const key = rawKey.trim()
  if (key.length === 0) {
    return { ok: false, message: 'Key 不能为空' }
  }
  if (key.length > AI_PERSONAL_KEY_MAX_LENGTH) {
    return { ok: false, message: `Key 长度不能超过 ${AI_PERSONAL_KEY_MAX_LENGTH} 个字符` }
  }
  if (!AI_PERSONAL_KEY_PATTERN.test(key)) {
    return { ok: false, message: 'Key 只能包含可打印字符，且不能包含空格或换行' }
  }
  return { ok: true }
}

function parseStoredValue(raw: string | null): StoredValue | null {
  if (raw === null || raw === '') {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StoredCredential> & Partial<StoredTombstone>
    if (parsed?.schemaVersion !== 1) {
      return null
    }
    if (parsed.deleted === true) {
      return { schemaVersion: 1, deleted: true }
    }
    const source = CREDENTIAL_SOURCE_VALUES.find(value => value === parsed.source)
    if (source === undefined || typeof parsed.key !== 'string' || !validatePersonalKeyShape(parsed.key).ok) {
      return null
    }
    return { schemaVersion: 1, source, key: parsed.key }
  }
  catch {
    return null
  }
}

function storedEquals(a: StoredValue | null, b: StoredValue | null): boolean {
  if (a === null || b === null) {
    return a === b
  }
  if ('deleted' in a || 'deleted' in b) {
    return 'deleted' in a && 'deleted' in b
  }
  return a.source === b.source && a.key === b.key
}

/**
 * 清除意图的判定目标：把"本次操作实际需要清理的持久化副本"与"当前页内 Key"
 * 区分开（替换后删除时两者不同），首次执行与重试共用同一判定，避免两套目标
 * 判断产生不同结果。
 */
interface RemovalTargets {
  /** 本次操作针对的页内 Key（用户当前所见并决定清除的 Key）；null 表示页内无 Key。 */
  targetKey: string | null
  /**
   * 创建意图时本页自己的存储基线 Key（origin 为 own 的凭据）——如替换写入
   * 失败遗留、清除它正是操作目的的旧副本；重试时同样允许清除（读取故障期间
   * 存储实际仍是该副本）。外部基线（origin 为 external）不属于本页的清理
   * 责任，不计入。null 表示无本页基线（基线为墓碑 / 无条目 / 外部状态）。
   */
  baselineKey: string | null
}

/** 存储中的凭据是否属于本次清除意图的判定目标（按 Key 判定：外部仅改变来源不妨碍清除）。 */
function isRemovalTargetKey(key: string, targets: RemovalTargets): boolean {
  return key === targets.targetKey || key === targets.baselineKey
}

export function useJevCredentials() {
  const source = ref<AiCredentialSource>('site')
  const personalKey = ref<string | null>(null)
  const rememberKey = ref(false)
  /** localStorage 不可访问（隐私模式 / 被禁用）：退回纯内存模式。 */
  const storageUnavailable = ref(false)
  /** 可重试的持久化问题（写入 / 清除失败但存储仍可访问）。 */
  const persistProblem = ref<JevKeyPersistProblem | null>(null)
  /**
   * 个人 Key 版本：每次 Key 内容实际变化（保存 / 替换 / 删除 / 跨页同步采纳）递增。
   * 用于把"提示已确认"状态关联到具体 Key：同一 Key 的连续失败不重复打扰，
   * 新 Key 的失败必须重新显示原因与修改入口。
   */
  const personalKeyVersion = ref(0)

  /** 本页最后一次写入或同步到的存储值；null 表示无条目。写入前据此做 CAS 检查。 */
  let lastStored: StoredValue | null = null
  /**
   * lastStored 的来源：own 表示本页自己的写入或挂载基线（如替换写入失败留下的
   * 陈旧旧副本，清除它正是操作目的）；external 表示经 storage 事件或写前同步
   * 采纳的外部状态（其中不同的 Key 不得被本页清除误删）。
   */
  let lastStoredOrigin: 'own' | 'external' = 'own'
  /** 本页存在未成功持久化的本地新 Key（刚输入 / 替换但未写入或未记住）：外部同步不覆盖。 */
  let localDirty = false
  /**
   * 未完成的持久化操作意图（保存 / 取消记住 / 删除），在读取失败或写入失败时
   * 保留，供恢复访问后重试；不由当前 rememberKey / personalKey 反推。新的用户
   * 操作会以自身意图覆盖它；外部取消记住 / 删除生效后，过期的保存意图与其
   * 提示会被清除。清除意图携带判定目标，重试与首次执行共用同一判定。
   */
  let pendingPersist: { op: 'save', explicit: boolean } | { op: 'unremember' | 'delete', targets: RemovalTargets } | null = null

  const hasPersonalKey = computed(() => personalKey.value !== null)
  /** 当前生效的凭据快照；useUnoGame 交给 useAiTurn 调度使用。 */
  const credential = computed<JevCredential>(() => ({ source: source.value, personalKey: personalKey.value }))

  // Key 内容变化即递增版本；同值赋值不触发（Vue ref 相同值不通知）。
  // sync flush：版本必须与 Key 内容同步更新，供提示确认状态即时失效。
  watch(personalKey, (next, previous) => {
    if (next !== previous) {
      personalKeyVersion.value++
    }
  }, { flush: 'sync' })

  /** 读取并解析存储项；读取异常按存储不可用处理（此时不做任何写前判断）。 */
  function readStoredValue(): { value: StoredValue | null, error: boolean } {
    if (!localStorageAccessible()) {
      storageUnavailable.value = true
      return { value: null, error: true }
    }
    try {
      return { value: parseStoredValue(window.localStorage.getItem(JEV_KEY_STORAGE_KEY)), error: false }
    }
    catch {
      storageUnavailable.value = true
      return { value: null, error: true }
    }
  }

  /**
   * 采纳外部存储状态（storage 事件或写前 CAS 检查发现外部变化）。
   * - 本页有未持久化的新 Key（localDirty）：保持独立，仅更新基线。
   * - 外部为新凭据：所有页面镜像最新 Key；来源仅在"已记住"页面跟随
   *   （未记住页面的来源选择是页内决定）。keepLocalSource 用于本页刚发生
   *   来源切换等写意图时：采纳外部 Key 但保留本页的来源意图。
   * - 外部为墓碑（另一页删除）：本页同步删除记忆中的 Key，绝不复活。
   * - 外部为移除（另一页取消记住）：Key 保留在本页内存，转为未记住。
   * - 墓碑与移除都意味着外部已不打算记住该 Key：待重试的保存意图就此过期
   *   （重试不得把旧请求的 Key 重新持久化），与其提示一并清除。
   */
  function syncFromExternal(stored: StoredValue | null, options: { keepLocalSource?: boolean } = {}) {
    lastStored = stored
    lastStoredOrigin = 'external'
    if (localDirty) {
      return
    }
    if (stored !== null && 'key' in stored) {
      personalKey.value = stored.key
      if (rememberKey.value && !options.keepLocalSource) {
        source.value = stored.source
      }
    }
    else {
      if (stored !== null) {
        personalKey.value = null
        source.value = 'site'
      }
      rememberKey.value = false
      if (pendingPersist !== null && pendingPersist.op === 'save') {
        pendingPersist = null
        persistProblem.value = null
      }
    }
  }

  /** storage 事件（其他标签页修改）与 bfcache 恢复后的主动重同步。 */
  function resyncFromStorage() {
    const { value, error } = readStoredValue()
    if (error) {
      return
    }
    if (!storedEquals(value, lastStored)) {
      syncFromExternal(value)
    }
  }

  /** 写入失败后检查旧副本是否仍残留在存储中（刷新会恢复它而不是新 Key）。 */
  function staleCopyDiffersFrom(key: string): boolean {
    const { value, error } = readStoredValue()
    if (error) {
      return lastStored !== null && 'key' in lastStored && lastStored.key !== key
    }
    return value !== null && 'key' in value && value.key !== key
  }

  /** 捕获清除意图的判定目标：页内目标 Key + 本页自己的存储基线副本（如有）。 */
  function captureRemovalTargets(targetKey: string | null): RemovalTargets {
    return {
      targetKey,
      baselineKey: lastStoredOrigin === 'own' && lastStored !== null && 'key' in lastStored ? lastStored.key : null,
    }
  }

  /**
   * 写入已记住凭据（调用方保证 rememberKey 且 personalKey 非空）。
   * explicit 区分"用户显式勾选记住"与"切换来源 / 保存 Key 附带的持久化"。
   * 写前 CAS：外部状态变化时先同步——已记住且无本地新 Key 的页面采纳外部 Key
   * 再写入（不覆盖另一页面刚保存的新 Key）；外部删除且无本地新 Key 时不写入
   * （不复活已删除的 Key）。有本地新 Key 时按本页最新意图写入。
   * 每次实际保存前（含重试路径，无论存储基线是否变化）检查当前有效的保存
   * 意图：外部取消记住经 storage 事件或写前同步生效后（rememberKey 已同步为
   * false），过期的保存意图不再把 Key 写回，待重试操作与提示一并清除——避免
   * 旧标签页的附带保存撤销另一页已同步的取消记住；用户显式勾选记住
   * （rememberKey 为 true）的意图仍优先并正常写入。
   */
  function attemptPersistSave(explicit: boolean): boolean {
    const { value: current, error } = readStoredValue()
    if (error) {
      // 读取失败不代表持久化副本不存在：保留保存意图，如实提示结果未知
      pendingPersist = { op: 'save', explicit }
      persistProblem.value = {
        kind: 'storage-error',
        op: 'save',
        staleCopyPossible: lastStored !== null && 'key' in lastStored && lastStored.key !== personalKey.value,
      }
      return false
    }
    if (!storedEquals(current, lastStored)) {
      // 采纳外部 Key 但保留本页的来源意图（如刚切换来源触发的写入）
      syncFromExternal(current, { keepLocalSource: true })
      if (explicit) {
        // 用户显式勾选记住的意图优先于外部刚同步来的取消记住
        rememberKey.value = true
      }
    }
    if (!rememberKey.value) {
      // 当前有效意图已不是"记住"（外部取消记住已生效，含过期的重试保存）：
      // 本次不持久化该 Key，过期的待重试操作与提示一并清除
      persistProblem.value = null
      pendingPersist = null
      return true
    }
    const key = personalKey.value
    if (key === null) {
      // 无凭据可写（外部已删除且本页没有未持久化的新 Key）：不复活已删除的 Key
      persistProblem.value = null
      pendingPersist = null
      return true
    }
    const value: StoredCredential = { schemaVersion: 1, source: source.value, key }
    try {
      window.localStorage.setItem(JEV_KEY_STORAGE_KEY, JSON.stringify(value))
      lastStored = value
      lastStoredOrigin = 'own'
      localDirty = false
      persistProblem.value = null
      pendingPersist = null
      // 成功访问并写入证明存储可用：清除"存储不可用"状态
      storageUnavailable.value = false
      return true
    }
    catch {
      persistProblem.value = { kind: 'save-failed', staleCopyRemains: staleCopyDiffersFrom(value.key) }
      pendingPersist = { op: 'save', explicit }
      return false
    }
  }

  /**
   * 清除持久化副本（调用方已更新页内状态）。
   * - delete 写入墓碑标记，使其他标签页把"删除"与"取消记住"区分开。
   * - targets 是本次清除意图的判定目标（创建意图时捕获，重试原样复用）：
   *   操作针对的页内 Key + 本页自己的存储基线 Key（替换写入失败遗留的旧副本
   *   ——清除它正是操作目的）。按 Key 判定：外部仅改变同一 Key 的来源时照常
   *   清除；外部（或重试期间）保存了判定目标之外的新 Key 时不误删、不虚报
   *   成功，报告冲突。首次执行与重试共用本判定。
   * - 存储已是墓碑时：凭据已全局删除。取消记住不得移除墓碑（会把其他页的
   *   删除降级为取消记住），删除也无需重写。
   * - 读取失败不代表副本不存在：保留操作意图与判定目标，恢复访问后可重试。
   */
  function attemptPersistRemoval(mode: 'unremember' | 'delete', targets: RemovalTargets): boolean {
    const { value: current, error } = readStoredValue()
    if (error) {
      pendingPersist = { op: mode, targets }
      persistProblem.value = {
        kind: 'storage-error',
        op: mode,
        staleCopyPossible: targets.targetKey !== null || (lastStored !== null && 'key' in lastStored),
      }
      return false
    }
    // 存储已是墓碑：凭据已全局删除，无需（也不得）再动存储
    if (current !== null && 'deleted' in current) {
      lastStored = current
      lastStoredOrigin = 'external'
      persistProblem.value = null
      pendingPersist = null
      return true
    }
    // 存储是判定目标之外的 Key（外部新保存，或重试期间被外部替换）：不得误删
    // 新凭据，也不能虚报清除成功
    if (current !== null && 'key' in current && !isRemovalTargetKey(current.key, targets)) {
      lastStored = current
      lastStoredOrigin = 'external'
      pendingPersist = null
      persistProblem.value = { kind: 'conflict', op: mode }
      return false
    }
    // 判定目标之内（含仅来源变化）或条目已不存在：按本页意图清除
    if (current === null && mode === 'unremember') {
      // 外部已取消记住（条目移除）：无剩余动作
      lastStored = null
      persistProblem.value = null
      pendingPersist = null
      return true
    }
    try {
      if (mode === 'delete') {
        // 删除写墓碑——即使条目已被外部移除，也把删除同步到仍持有页内 Key 的标签页
        window.localStorage.setItem(JEV_KEY_STORAGE_KEY, JSON.stringify({ schemaVersion: 1, deleted: true } satisfies StoredTombstone))
        lastStored = { schemaVersion: 1, deleted: true }
      }
      else {
        window.localStorage.removeItem(JEV_KEY_STORAGE_KEY)
        lastStored = null
      }
      lastStoredOrigin = 'own'
      persistProblem.value = null
      pendingPersist = null
      // 成功访问并写入证明存储可用：清除"存储不可用"状态
      storageUnavailable.value = false
      return true
    }
    catch {
      persistProblem.value = { kind: 'remove-failed' }
      pendingPersist = { op: mode, targets }
      return false
    }
  }

  // 挂载后恢复记住的 Key（SSR 与客户端首帧都用默认值，避免水合不一致）
  onMounted(() => {
    const { value, error } = readStoredValue()
    if (error) {
      return
    }
    lastStored = value
    lastStoredOrigin = 'own'
    localDirty = false
    if (value !== null && 'key' in value) {
      personalKey.value = value.key
      source.value = value.source
      rememberKey.value = true
    }
    // 其他标签页修改 unojev:jev-key 时同步（本页自己的写入不触发本页事件）
    window.addEventListener('storage', onStorageEvent)
  })

  function onStorageEvent(event: StorageEvent) {
    // key 为 null 表示 storage.clear()，同样需要重同步
    if (event.key !== JEV_KEY_STORAGE_KEY && event.key !== null) {
      return
    }
    resyncFromStorage()
  }

  onBeforeUnmount(() => {
    window.removeEventListener('storage', onStorageEvent)
  })

  /** 切换凭据来源；记住状态下附带持久化来源选择（写前同步若发现外部已取消记住则跳过）。 */
  function setSource(next: AiCredentialSource) {
    source.value = next
    if (rememberKey.value && personalKey.value !== null) {
      attemptPersistSave(false)
    }
  }

  /**
   * 保存 / 替换个人 Key：立即写入页面内存（本页即时生效），勾选记住时写入本地存储。
   * 写入失败时 Key 仍在本页使用，以 persistProblem 准确提示旧副本状态并可重试。
   * 只校验形状，不发起任何收费的验证请求。
   */
  function savePersonalKey(rawKey: string): PersonalKeySaveResult {
    const result = validatePersonalKeyShape(rawKey)
    if (!result.ok) {
      return result
    }
    personalKey.value = rawKey.trim()
    localDirty = true
    if (rememberKey.value) {
      attemptPersistSave(false)
    }
    return { ok: true }
  }

  /**
   * 勾选记住：显式持久化当前 Key（外部取消记住不覆盖该意图）；取消记住：仅删除
   * 持久化副本（内存 Key 保留）。清除失败或读取失败时以 persistProblem 准确提示，可重试。
   */
  function setRememberKey(enabled: boolean) {
    rememberKey.value = enabled
    if (enabled) {
      if (personalKey.value !== null) {
        attemptPersistSave(true)
      }
      return
    }
    attemptPersistRemoval('unremember', captureRemovalTargets(personalKey.value))
  }

  /**
   * 删除个人 Key：同时清除内存与持久化副本（写入墓碑标记），并回到默认的
   * 站点额度来源。删除是用户的显式决定，不属于"个人模式缺 Key 时悄悄改用站点额度"。
   * 墓碑清除失败时以 persistProblem 提示，可重试。
   */
  function deletePersonalKey() {
    const targetKey = personalKey.value
    personalKey.value = null
    rememberKey.value = false
    localDirty = false
    source.value = 'site'
    attemptPersistRemoval('delete', captureRemovalTargets(targetKey))
  }

  /**
   * 重试上次未完成的持久化操作。操作意图在失败时被显式记录（保存 / 取消记住 /
   * 删除及判定目标），不由当前 rememberKey / personalKey 反推；新的用户操作会
   * 以自身意图覆盖旧意图。清除类重试直接以创建意图时的判定目标重新执行——
   * 与首次执行共用同一判定：目标之内（含仅来源变化与本页遗留的旧副本）照常
   * 清除，重试期间外部新保存的 Key 不误删、转为冲突提示。
   */
  function retryPersist() {
    const pending = pendingPersist
    if (pending === null || persistProblem.value === null) {
      return
    }
    if (pending.op === 'save') {
      attemptPersistSave(pending.explicit)
      return
    }
    attemptPersistRemoval(pending.op, pending.targets)
  }

  return {
    source: readonly(source),
    rememberKey: readonly(rememberKey),
    storageUnavailable: readonly(storageUnavailable),
    persistProblem: readonly(persistProblem),
    /** 个人 Key 版本；用于把提示确认状态关联到具体 Key。 */
    personalKeyVersion: readonly(personalKeyVersion),
    /** 是否已配置个人 Key（不暴露 Key 本身，避免界面误渲染）。 */
    hasPersonalKey,
    /** 仅供 AI 调度使用的凭据快照（含 Key 值），不用于界面展示。 */
    credential,
    setSource,
    savePersonalKey,
    setRememberKey,
    deletePersonalKey,
    retryPersist,
    /** bfcache 恢复等场景的主动重同步（storage 事件在缓存期间不会送达）。 */
    resyncFromStorage,
  }
}

export type JevCredentials = ReturnType<typeof useJevCredentials>
