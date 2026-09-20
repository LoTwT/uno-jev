import type { Ref } from 'vue'
import type { GameState, SaveEnvelopeV1, SaveLoadResult } from '#shared/game'
/**
 * 浏览器存档：唯一对局槽位 unojev:save 的加载、校验、整体快照保存与失败处理。
 *
 * 用 VueUse useLocalStorage 绑定完整 envelope：显式对象 serializer、
 * writeDefaults: false、deep: false、同步写入时序（flush: 'sync'）、mounted 后初始化；
 * 游戏通过整体替换新快照提交，不靠深层 watcher 保存每一步手牌变更。
 * 写入失败时保留旧槽位与本页内存状态，不显示虚假的"已保存"（规格：浏览器持久化）。
 */
import { useLocalStorage } from '@vueuse/core'
import { readonly, ref } from 'vue'
import { loadSaveEnvelope } from '#shared/game'
import { localStorageAccessible, storageWindow } from '~/utils/storage'

export const SAVE_KEY = 'unojev:save'

export type SaveHealth = 'ok' | 'failed' | 'memory-only'

export interface SaveSignature {
  gameId: string
  revision: number
  writerId: string
}

export interface InitialLoad {
  status: 'absent' | 'valid' | 'invalid'
  envelope?: SaveEnvelopeV1
  message?: string
  errors?: string[]
}

export interface GamePersistence {
  /** 校验失败时的原始槽位仍存在；用于"存档无法读取"提示。 */
  rawSlotExists: Readonly<Ref<boolean>>
  /** 最近一次持久化是否成功；memory-only 表示不再尝试写共享槽位。 */
  saveHealth: Readonly<Ref<SaveHealth>>
  /** 浏览器存储是否可访问；不可用时界面明确提供不保存的临时对局。 */
  storageAvailable: Readonly<Ref<boolean>>
  /** 最后成功读取 / 保存的槽位签名，用于外部修改检测。 */
  lastKnownSignature: Readonly<Ref<SaveSignature | null>>
  loadInitial: () => InitialLoad
  /** 引擎完成整次转换后立即保存；返回 false 表示写入失败。 */
  persist: (state: GameState, writerId: string) => boolean
  /** 检查槽位是否仍与本页最后已知签名一致（持锁期间每次提交前调用）。 */
  verifySlot: () => 'ok' | 'missing' | 'conflict' | 'storage-error'
  retrySave: (state: GameState, writerId: string) => boolean
  enterMemoryOnly: () => void
  /** 用户确认后清除无法读取的存档。 */
  clearSlot: () => void
  /** 只读页读取最新槽位用于展示（经校验才更新）。 */
  readForDisplay: () => InitialLoad
}

/** envelope 的槽位签名；会话层与页面用它比较"用户确认过的版本"。 */
export function envelopeSignature(envelope: SaveEnvelopeV1): SaveSignature {
  return {
    gameId: envelope.state.gameId,
    revision: envelope.state.revision,
    writerId: envelope.writerId,
  }
}

/** 两个签名是否指向同一版本（gameId / revision / writerId 全部一致）。 */
export function sameSignature(a: SaveSignature | null, b: SaveSignature | null): boolean {
  if (a === null || b === null) {
    return a === b
  }
  return a.gameId === b.gameId && a.revision === b.revision && a.writerId === b.writerId
}

export function useGamePersistence(): GamePersistence {
  const rawSlotExists = ref(false)
  const saveHealth = ref<SaveHealth>('ok')
  const storageAvailable = ref(localStorageAccessible())
  const lastKnownSignature = ref<SaveSignature | null>(null)

  // 写失败检测：VueUse 的 write 内部捕获 setItem 异常并调用 onError
  let writing = false
  let writeFailed = false
  const onError = (error: unknown) => {
    if (writing) {
      writeFailed = true
    }
    console.warn('[unojev] storage 操作失败:', error)
  }

  const envelope = useLocalStorage<SaveEnvelopeV1 | null>(SAVE_KEY, null, {
    serializer: {
      // 校验失败的原始内容保留在槽位中；读取结果为 null 但 rawSlotExists 为 true。
      // write(null) 只出现在 VueUse 初始化的读取比较路径，序列化为字面量 "null"，
      // 不会触发 setItem，也不会覆盖原槽位。
      read: (raw: string) => {
        try {
          const result: SaveLoadResult = loadSaveEnvelope(raw)
          return result.ok ? result.envelope : null
        }
        catch {
          return null
        }
      },
      write: (value: SaveEnvelopeV1 | null) => JSON.stringify(value),
    },
    writeDefaults: false,
    deep: false,
    flush: 'sync',
    initOnMounted: true,
    listenToStorageChanges: false,
    onError,
    // 存储属性访问本身可能抛 SecurityError：不可用时传 null，VueUse 回退为内存 ref
    window: storageWindow(),
  })

  function signatureOf(env: SaveEnvelopeV1): SaveSignature {
    return envelopeSignature(env)
  }

  function readRaw(): string | null {
    if (!localStorageAccessible()) {
      storageAvailable.value = false
      return null
    }
    storageAvailable.value = true
    try {
      return window.localStorage.getItem(SAVE_KEY)
    }
    catch {
      return null
    }
  }

  function loadFromRaw(raw: string | null): InitialLoad {
    if (raw === null || raw === '') {
      rawSlotExists.value = false
      return { status: 'absent' }
    }
    rawSlotExists.value = true
    const result = loadSaveEnvelope(raw)
    if (!result.ok) {
      if (result.reason !== 'absent') {
        return { status: 'invalid', message: result.message, errors: result.errors }
      }
      return { status: 'absent' }
    }
    lastKnownSignature.value = signatureOf(result.envelope)
    return { status: 'valid', envelope: result.envelope }
  }

  function loadInitial(): InitialLoad {
    // useLocalStorage（initOnMounted）已完成首次读取；这里以原始内容为准做权威判定
    const raw = readRaw()
    const loaded = loadFromRaw(raw)
    if (loaded.status === 'valid') {
      envelope.value = loaded.envelope
    }
    return loaded
  }

  function readForDisplay(): InitialLoad {
    return loadFromRaw(readRaw())
  }

  function persist(state: GameState, writerId: string): boolean {
    if (saveHealth.value === 'memory-only') {
      // 临时对局：不再尝试覆盖原槽位
      return true
    }
    const next: SaveEnvelopeV1 = {
      schemaVersion: 1,
      savedAt: new Date().toISOString(),
      writerId,
      state,
    }
    writing = true
    writeFailed = false
    try {
      envelope.value = next
    }
    finally {
      writing = false
    }
    if (writeFailed) {
      saveHealth.value = 'failed'
      return false
    }
    saveHealth.value = 'ok'
    lastKnownSignature.value = signatureOf(next)
    return true
  }

  function retrySave(state: GameState, writerId: string): boolean {
    // 重试前检查旧槽位仍匹配本页最后成功保存的签名；不匹配按冲突处理
    const verify = verifySlot()
    if (verify !== 'ok' && !(verify === 'missing' && lastKnownSignature.value === null)) {
      return false
    }
    return persist(state, writerId)
  }

  function verifySlot(): 'ok' | 'missing' | 'conflict' | 'storage-error' {
    if (!localStorageAccessible()) {
      storageAvailable.value = false
      return 'storage-error'
    }
    let raw: string | null
    try {
      raw = window.localStorage.getItem(SAVE_KEY)
    }
    catch {
      return 'storage-error'
    }
    if (raw === null || raw === '') {
      // 从未保存过且槽位本就不存在，不算冲突
      if (lastKnownSignature.value === null) {
        return 'ok'
      }
      return 'missing'
    }
    try {
      const parsed = JSON.parse(raw) as Partial<SaveEnvelopeV1>
      const current: SaveSignature | null = parsed?.state && typeof parsed.state.gameId === 'string' && typeof parsed.state.revision === 'number' && typeof parsed.writerId === 'string'
        ? { gameId: parsed.state.gameId, revision: parsed.state.revision, writerId: parsed.writerId }
        : null
      if (current === null) {
        return 'conflict'
      }
      const known = lastKnownSignature.value
      if (known === null) {
        // 本页尚未保存过：槽位内容是加载时的内容或外部新写入
        return 'ok'
      }
      if (current.gameId !== known.gameId || current.revision !== known.revision || current.writerId !== known.writerId) {
        return 'conflict'
      }
      return 'ok'
    }
    catch {
      return 'conflict'
    }
  }

  function enterMemoryOnly() {
    saveHealth.value = 'memory-only'
  }

  function clearSlot() {
    try {
      window.localStorage.removeItem(SAVE_KEY)
      rawSlotExists.value = false
      lastKnownSignature.value = null
      envelope.value = null
    }
    catch (error) {
      console.warn('[unojev] 清除存档失败:', error)
    }
  }

  return {
    rawSlotExists: readonly(rawSlotExists),
    saveHealth: readonly(saveHealth),
    storageAvailable: readonly(storageAvailable),
    lastKnownSignature: readonly(lastKnownSignature),
    loadInitial,
    persist,
    verifySlot,
    retrySave,
    enterMemoryOnly,
    clearSlot,
    readForDisplay,
  }
}
