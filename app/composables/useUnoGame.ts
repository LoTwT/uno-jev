import type {
  ApplyActionResult,
  Card,
  Color,
  DecisionSource,
  FallbackReason,
  GameState,
  LegalAction,
  Player,
  PlayerId,
  PublicEvent,
} from '#shared/game'
import type { InitialLoad, SaveSignature } from './useGamePersistence'
/**
 * 对局会话编排：持有唯一当前状态、串行提交命令、派生 UI 数据，
 * 连接规则引擎、持久化、多标签页控制与 AI 调度。
 *
 * 页面组件不重复实现规则；保存时机为引擎完成整次转换后立即保存，
 * 先保存再开放下一操作 / 启动下一 AI 请求（规格：模块职责与信任边界）。
 */
import { computed, onMounted, ref, shallowRef } from 'vue'
import { applyAction, createGame, getCard, isWildKind } from '#shared/game'
import { useAiTurn } from './useAiTurn'
import { useGameLock, webLocksSupported } from './useGameLock'
import { envelopeSignature, sameSignature, useGamePersistence } from './useGamePersistence'

export type SessionStatus
  = | 'boot'
    | 'entry'
    | 'playing'
    | 'readonly-locked'
    | 'no-lock-browser'
    | 'invalid-save'
    | 'slot-conflict'

export type ControlMode = 'locked' | 'temp'

/** 新开一局的会话结果：需要用户确认覆盖时返回 needs-confirmation。 */
export type StartNewGameResult = 'started' | 'needs-confirmation' | 'blocked'

export interface HandCardView {
  card: Card
  playable: boolean
  /** 不可出原因（中文，供无障碍说明）。 */
  reason: string | null
  /** after-draw 阶段刚抽到的牌。 */
  isDrawn: boolean
}

export interface OpponentView {
  player: Player
  /** 最近一次决策来源（从公开事件派生，刷新后仍可见）。 */
  lastSource: DecisionSource | null
  lastFallbackReason: FallbackReason | null
}

function freshUuid(): string {
  return globalThis.crypto?.randomUUID?.() ?? `w-${Math.random().toString(36).slice(2)}-${Date.now()}`
}

export function useUnoGame() {
  const status = ref<SessionStatus>('boot')
  const state = shallowRef<GameState | null>(null)
  const controlMode = ref<ControlMode>('locked')
  const entrySave = shallowRef<InitialLoad>({ status: 'absent' })
  /** 引擎 / 存档错误提示（界面顶部呈现，动作错误同样进入公开日志）。 */
  const actionError = ref<string | null>(null)

  /** 本页面随机标识；不是账号或设备标识。 */
  const writerId = freshUuid()

  const persistence = useGamePersistence()
  const lock = useGameLock()

  /**
   * 本页对局不再读写共享槽位：临时对局（无 Web Locks / 存储不可用），
   * 或用户已明确选择"仅在此页继续"。这类会话的推进不依赖共享槽位的控制权。
   */
  function isMemoryOnlySession(): boolean {
    return controlMode.value === 'temp' || persistence.saveHealth.value === 'memory-only'
  }

  /** 是否允许自动推进 AI（页面可见、持锁 / 内存模式、存档未失败）。 */
  function canAdvance(): boolean {
    if (status.value !== 'playing') {
      return false
    }
    if (!isMemoryOnlySession() && !lock.held.value) {
      return false
    }
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
      return false
    }
    return persistence.saveHealth.value !== 'failed'
  }

  const aiTurn = useAiTurn({
    getState: () => state.value,
    canAdvance,
    submitAction: (actorId, action, meta) => submitAction(actorId, action, meta),
    // 开发诊断（仅本地控制台；不含密钥或暗牌）
    devLog: message => console.warn(`[unojev][diagnostic] ${message}`),
  })

  // ---- 串行命令队列 -------------------------------------------------------
  let queue: Promise<unknown> = Promise.resolve()
  /** 串行执行命令并返回其结果；异常被捕获记录，调用方无需处理拒绝。 */
  function enqueue<T>(run: () => T | Promise<T>): Promise<T | undefined> {
    const result = queue.then(run).catch((error) => {
      console.error('[unojev] 命令执行异常:', error)
      return undefined
    })
    queue = result
    return result
  }

  // ---- 保存与冲突 ---------------------------------------------------------
  function persistCurrent(): boolean {
    if (isMemoryOnlySession()) {
      return true
    }
    if (!lock.held.value) {
      return false
    }
    return persistence.persist(state.value!, writerId)
  }

  const slotProblemKind = ref<'missing' | 'conflict' | 'storage-error' | null>(null)

  function handleSlotProblem(kind: 'missing' | 'conflict' | 'storage-error') {
    // 停止写入、取消旧请求，提示重新加载最新存档；不能用本页过期内存覆盖
    aiTurn.cancelAll()
    status.value = 'slot-conflict'
    slotProblemKind.value = kind
  }

  // ---- 动作提交 -----------------------------------------------------------
  function submitAction(
    actorId: PlayerId,
    action: LegalAction,
    meta?: { aiSource: DecisionSource, fallbackReason?: FallbackReason },
  ): boolean {
    if (status.value !== 'playing' || state.value === null) {
      return false
    }
    // 内存模式（临时对局 / 仅此页继续）不写共享槽位，不需要控制权
    if (!isMemoryOnlySession() && !lock.held.value) {
      return false
    }
    // 持锁期间比较持久化槽位与最后成功读取 / 保存的签名；
    // 仅签名确实变化（外部改写 / 删除）才按冲突处理，存储读取异常留给写入失败路径
    if (controlMode.value === 'locked' && persistence.saveHealth.value !== 'memory-only') {
      const verify = persistence.verifySlot()
      if (verify === 'conflict' || verify === 'missing') {
        handleSlotProblem(verify)
        return false
      }
    }
    const current = state.value
    const result: ApplyActionResult = applyAction(
      current,
      { actorId, gameId: current.gameId, expectedRevision: current.revision, action },
      meta === undefined ? undefined : { meta },
    )
    if (!result.ok) {
      actionError.value = result.message
      console.warn(`[unojev] 动作被拒绝: ${result.error} ${result.message}`)
      return false
    }
    actionError.value = null
    state.value = result.state
    // 引擎完成整次转换后立即保存（含所有连带罚牌），再开放下一操作
    const saved = persistCurrent()
    if (state.value.phase.kind !== 'finished') {
      if (saved || persistence.saveHealth.value !== 'failed') {
        aiTurn.schedule()
      }
      // 保存失败时暂停自动推进，由用户选择重试保存或仅此页继续
    }
    return true
  }

  // ---- 会话初始化 ---------------------------------------------------------
  /**
   * 最近一次展示"存档无法读取"时的原始槽位内容。
   * 用户确认清除前据此核对内容是否已被其他页面替换（坏档没有可用于比较的签名）。
   */
  const invalidSlotRaw = shallowRef<string | null>(null)

  /**
   * 进入"存档无法读取"流程：保留原始槽位内容，记录展示给用户的原始文本，
   * 只有用户明确选择"清除并新开一局"才会替换槽位。
   */
  function enterInvalidSave(load: InitialLoad) {
    entrySave.value = load
    invalidSlotRaw.value = persistence.readRawSlot()
    status.value = 'invalid-save'
  }

  async function initialize() {
    if (status.value !== 'boot') {
      return
    }
    if (!webLocksSupported()) {
      // 缺少 Web Locks：允许查看存档或明确选择不保存的临时对局
      entrySave.value = persistence.readForDisplay()
      status.value = 'no-lock-browser'
      return
    }
    const granted = await lock.request()
    if (!granted) {
      entrySave.value = persistence.readForDisplay()
      status.value = 'readonly-locked'
      watchForControlRelease()
      return
    }
    const load = persistence.loadInitial()
    if (load.status === 'invalid') {
      enterInvalidSave(load)
      return
    }
    entrySave.value = load
    status.value = 'entry'
  }

  /** 只读页：storage 事件时仅更新经校验的显示，不触发游戏动作。 */
  let storageListener: (() => void) | null = null
  function watchForControlRelease() {
    if (typeof window === 'undefined') {
      return
    }
    storageListener = () => {
      // 锁仍被持有时只刷新只读显示
      entrySave.value = persistence.readForDisplay()
    }
    window.addEventListener('storage', storageListener)
  }

  /** 只读页用户点击"在此页继续"：重新争取锁，重新读档再行动。 */
  async function tryTakeControl() {
    if (!webLocksSupported()) {
      return
    }
    const granted = await lock.request()
    if (granted) {
      if (storageListener !== null) {
        window.removeEventListener('storage', storageListener)
        storageListener = null
      }
      aiTurn.cancelAll()
      const load = persistence.loadInitial()
      if (load.status === 'invalid') {
        enterInvalidSave(load)
      }
      else {
        entrySave.value = load
        status.value = 'entry'
      }
    }
    else {
      entrySave.value = persistence.readForDisplay()
    }
  }

  /**
   * 入口操作前确保持有控制权（返回入口释放后可重新争取）。
   * 取得锁后重新读取最新存档：其他标签页可能在本页释放锁期间写入新进度。
   */
  async function ensureControl(): Promise<boolean> {
    if (controlMode.value === 'temp') {
      return true
    }
    if (!lock.held.value) {
      const granted = await lock.request()
      if (!granted) {
        // 其他标签页仍持有：保持入口 / 只读状态
        entrySave.value = persistence.readForDisplay()
        status.value = webLocksSupported() ? 'readonly-locked' : 'no-lock-browser'
        return false
      }
    }
    entrySave.value = persistence.loadInitial()
    return true
  }

  /** 当前槽位对应的版本签名；用于"用户确认过的版本"比较。 */
  function currentSlotSignature(): SaveSignature | null {
    if (status.value === 'playing') {
      return persistence.lastKnownSignature.value
    }
    const load = entrySave.value
    if (load.status === 'valid' && load.envelope) {
      return envelopeSignature(load.envelope)
    }
    return persistence.lastKnownSignature.value
  }

  /**
   * 用户是否已明确确认当前槽位版本。
   *
   * 省略参数表示"本次调用没有携带确认"；显式传入的签名必须与当前槽位一致才算确认。
   * 槽位没有有效签名（无法读取）时任何签名都不构成确认——不能以 null === null
   * 认定用户确认过，否则新发现的坏档会被静默覆盖。
   */
  function isConfirmedSlotVersion(confirmedSignature?: SaveSignature | null): boolean {
    if (confirmedSignature === undefined || confirmedSignature === null) {
      return false
    }
    const current = currentSlotSignature()
    return current !== null && sameSignature(current, confirmedSignature)
  }

  /** 槽位是否存在需要用户确认才可覆盖的内容（进行中的对局或无法读取的存档）。 */
  function slotNeedsConfirmation(): boolean {
    const load = entrySave.value
    if (load.status === 'invalid') {
      return true
    }
    if (load.status === 'valid' && load.envelope) {
      return load.envelope.state.phase.kind !== 'finished'
    }
    return false
  }

  async function startNewGame(confirmedSignature?: SaveSignature | null): Promise<StartNewGameResult> {
    const result = await enqueue(async (): Promise<StartNewGameResult> => {
      if (!(await ensureControl())) {
        return 'blocked'
      }
      // 取锁后新发现的坏档：保留原始内容并进入"存档无法读取"流程，
      // 只有用户在界面上明确选择"清除并新开一局"才可替换槽位
      if (entrySave.value.status === 'invalid') {
        enterInvalidSave(entrySave.value)
        return 'blocked'
      }
      // 写入前检查槽位是否仍对应用户确认过的版本；变化时更新界面并要求重新确认
      if (slotNeedsConfirmation() && !isConfirmedSlotVersion(confirmedSignature)) {
        return 'needs-confirmation'
      }
      aiTurn.cancelAll()
      const game = createGame({ gameId: freshUuid() })
      state.value = game
      status.value = 'playing'
      // 立即保存首个快照；失败时暂停自动推进并呈现重试入口
      persistCurrent()
      aiTurn.schedule()
      return 'started'
    })
    // 队列异常已由 enqueue 记录；此处按"未开始"处理，界面保持原状态
    return result ?? 'blocked'
  }

  function continueGame() {
    void enqueue(async () => {
      if (!(await ensureControl())) {
        return
      }
      // ensureControl 已按最新槽位刷新 entrySave；这里直接使用该权威快照
      let envelope = entrySave.value.status === 'valid' ? entrySave.value.envelope : undefined
      if (!envelope) {
        const fresh = persistence.readForDisplay()
        entrySave.value = fresh
        envelope = fresh.status === 'valid' ? fresh.envelope : undefined
        if (!envelope) {
          return
        }
      }
      aiTurn.cancelAll()
      // 刷新恢复到原决策点；不恢复旧 Promise、动画或请求
      state.value = envelope.state
      status.value = 'playing'
      aiTurn.schedule()
    })
  }

  /** 无 Web Locks 浏览器：明确选择"不保存的临时对局"。 */
  function startTempGame() {
    enqueue(() => {
      persistence.enterMemoryOnly()
      controlMode.value = 'temp'
      aiTurn.cancelAll()
      state.value = createGame({ gameId: freshUuid() })
      status.value = 'playing'
      aiTurn.schedule()
    })
  }

  /**
   * 存档无法读取时：用户确认清除并新开一局。
   * 清除前重新取得控制权并重读槽位：内容已被其他页面替换（换成新存档或另一份坏档）时
   * 更新界面并要求重新确认，避免清掉其他页面在此期间写入的进度。
   */
  function clearInvalidSaveAndStart() {
    enqueue(async () => {
      if (!(await ensureControl())) {
        return
      }
      const load = entrySave.value
      if (load.status === 'valid') {
        // 槽位已是可读存档：保留它，回到入口由用户按最新内容重新选择
        status.value = 'entry'
        return
      }
      if (load.status === 'invalid' && persistence.readRawSlot() !== invalidSlotRaw.value) {
        // 坏档内容已被其他页面改写：更新提示并要求重新确认
        enterInvalidSave(load)
        return
      }
      // 内容仍是用户确认过的坏档（或已被外部清除）：清除后新开
      if (load.status === 'invalid') {
        persistence.clearSlot()
      }
      entrySave.value = { status: 'absent' }
      invalidSlotRaw.value = null
      startNewGame()
    })
  }

  function reloadFromSlot() {
    void enqueue(async () => {
      if (!(await ensureControl())) {
        return
      }
      aiTurn.cancelAll()
      const load = persistence.loadInitial()
      entrySave.value = load
      if (load.status === 'valid' && load.envelope) {
        state.value = load.envelope.state
        status.value = 'playing'
        slotProblemKind.value = null
        // 内存已与槽位快照一致：清除此前的写入失败标记，避免恢复后无谓地暂停推进
        persistence.clearWriteFailure()
        aiTurn.schedule()
      }
      else if (load.status === 'invalid') {
        enterInvalidSave(load)
      }
      else {
        // 槽位被外部删除且无内容可载入：回到入口
        state.value = null
        status.value = 'entry'
      }
    })
  }

  function retrySave() {
    enqueue(async () => {
      if (state.value === null) {
        return
      }
      // 恢复写权限：pagehide 释放控制权后（历史缓存返回）需重新取锁再写，
      // 避免在没有独占锁的情况下写入共享槽位
      if (!isMemoryOnlySession() && !lock.held.value) {
        const granted = await lock.request()
        if (!granted) {
          // 其他标签页持有控制权：保留内存进度与失败提示，等待用户选择
          return
        }
      }
      // 重试前检查旧槽位仍匹配本页最后成功保存的签名；不匹配按冲突处理
      if (persistence.retrySave(state.value, writerId)) {
        aiTurn.schedule()
        return
      }
      // 再次写入失败（如持续配额不足）：保留当前内存进度与失败提示，
      // "重试保存"与"仅在此页继续"入口继续可用；只有槽位签名确实变化才算冲突
      const verify = persistence.verifySlot()
      if (verify === 'conflict' || verify === 'missing') {
        handleSlotProblem(verify)
      }
    })
  }

  /** 仅在此页继续：进入内存模式，保留本页进度（槽位冲突后同样可用）。 */
  function continueInMemoryOnly() {
    enqueue(() => {
      if (state.value === null) {
        return
      }
      persistence.enterMemoryOnly()
      if (status.value === 'slot-conflict') {
        // 用户选择保留本页未保存的进度继续，而不是加载外部存档
        slotProblemKind.value = null
        status.value = 'playing'
      }
      aiTurn.schedule()
    })
  }

  function exitToEntry() {
    enqueue(() => {
      // 返回游戏入口：停调度、取消请求、作废代次并释放锁
      aiTurn.cancelAll()
      state.value = null
      if (controlMode.value === 'locked') {
        lock.release()
      }
      controlMode.value = 'locked'
      const load = persistence.loadInitial()
      if (load.status === 'invalid') {
        enterInvalidSave(load)
        return
      }
      entrySave.value = load
      status.value = 'entry'
    })
  }

  function dismissActionError() {
    actionError.value = null
  }

  // ---- 页面生命周期：可见性、卸载与历史缓存恢复 ---------------------------
  /** pagehide（卸载 / 进入 bfcache）：释放控制权前先停调度、取消并作废在途请求。 */
  function handlePageHide() {
    aiTurn.cancelAll()
  }

  /**
   * 从历史缓存（bfcache）返回：按控制模式与保存状态区分恢复路径。
   * - 临时对局 / 仅此页继续：内存进度是唯一事实来源，不读共享槽位、不依赖锁；
   * - 保存失败：保留未保存的内存进度，重新取锁后核对槽位签名；锁不可用或槽位变化时
   *   不写入、不自动推进，交由界面提示用户在"重试保存 / 仅此页继续 / 重新加载"间选择；
   * - 已保存对局：重新争取锁并读取最新存档，未取得锁时显示只读状态。
   * 旧请求已在 pagehide 时作废，不会执行也不会触发兜底。
   */
  function handleRestored() {
    void enqueue(async () => {
      aiTurn.cancelAll()
      const wasPlaying = status.value === 'playing'
      if (wasPlaying && isMemoryOnlySession()) {
        // 内存进度是唯一事实来源：不读共享槽位，也不需要控制权
        aiTurn.schedule()
        return
      }
      if (wasPlaying && persistence.saveHealth.value === 'failed') {
        await restoreFailedSession()
        return
      }
      const granted = await lock.request()
      if (!granted) {
        entrySave.value = persistence.readForDisplay()
        status.value = webLocksSupported() ? 'readonly-locked' : 'no-lock-browser'
        return
      }
      const load = persistence.loadInitial()
      entrySave.value = load
      if (wasPlaying) {
        if (load.status === 'valid' && load.envelope) {
          // 采用最新存档（可能已被其他标签页推进），从当前决策点继续
          state.value = load.envelope.state
          status.value = 'playing'
          aiTurn.schedule()
        }
        else if (load.status === 'invalid') {
          state.value = null
          enterInvalidSave(load)
        }
        else {
          state.value = null
          status.value = 'entry'
        }
        return
      }
      if (load.status === 'invalid') {
        enterInvalidSave(load)
        return
      }
      if (status.value === 'readonly-locked' || status.value === 'no-lock-browser') {
        status.value = 'entry'
      }
    })
  }

  /**
   * 保存失败的对局从历史缓存返回：内存里是尚未写入槽位的进度。
   * 恢复写权限前先重新取锁并核对槽位签名；锁不可用或槽位已变化时不写入、
   * 不自动推进，保留内存进度与"重试保存 / 仅在此页继续 / 重新加载"入口供用户选择。
   */
  async function restoreFailedSession() {
    // 状态保持 playing：内存进度是用户可见的唯一进度，failed 会阻止自动推进
    const granted = await lock.request()
    if (!granted) {
      // 其他标签页持有控制权：本页只保留内存进度，重试保存会再次争取锁
      return
    }
    const verify = persistence.verifySlot()
    if (verify === 'conflict' || verify === 'missing') {
      // 槽位已被外部改写 / 删除：停止写入并让用户选择保留本页进度还是加载外部存档
      handleSlotProblem(verify)
    }
    // 保持 failed：不调度 AI，等待用户重试保存或选择仅在此页继续
  }

  function handleVisibility() {
    if (document.visibilityState === 'hidden') {
      // 页面隐藏仅暂停推进，仍保留控制权
      aiTurn.cancelAll()
    }
    else if (status.value === 'playing') {
      // 恢复可见后根据当前持久状态重新调度，不执行后台积攒的动作
      aiTurn.schedule()
    }
  }

  onMounted(() => {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibility)
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', handlePageHide)
    }
    // bfcache 返回时由锁层通知；旧请求已在 pagehide 作废
    lock.onRestored(handleRestored)
    void initialize()
  })

  // ---- 派生 UI 数据 --------------------------------------------------------
  const humanPlayer = computed<Player | null>(() => state.value?.players[0] ?? null)
  const opponents = computed<OpponentView[]>(() => {
    const game = state.value
    if (!game) {
      return []
    }
    return game.players.slice(1).map((player) => {
      let lastSource: DecisionSource | null = null
      let lastFallbackReason: FallbackReason | null = null
      for (let i = game.recentEvents.length - 1; i >= 0; i--) {
        const event = game.recentEvents[i]!
        if (event.type === 'decision-source' && event.playerId === player.id) {
          lastSource = event.source
          lastFallbackReason = event.reason ?? null
          break
        }
      }
      return { player, lastSource, lastFallbackReason }
    })
  })
  const topCard = computed<Card | null>(() => {
    const game = state.value
    if (!game) {
      return null
    }
    const topId = game.discardPile[game.discardPile.length - 1]
    return topId ? getCard(topId) : null
  })
  const isHumanTurn = computed(() =>
    status.value === 'playing'
    && state.value !== null
    && state.value.currentPlayerId === 'p0'
    && state.value.phase.kind !== 'finished',
  )
  const phaseKind = computed(() => state.value?.phase.kind ?? null)
  const drawnCardId = computed(() => {
    const phase = state.value?.phase
    return phase?.kind === 'after-draw' ? phase.drawnCardId : null
  })

  /** 真人手牌（含可玩性与原因）；after-draw 时只有刚抽到的牌可出。 */
  const handCards = computed<HandCardView[]>(() => {
    const game = state.value
    if (!game) {
      return []
    }
    const human = game.players[0]!
    const drawnId = game.phase.kind === 'after-draw' ? game.phase.drawnCardId : null
    return human.hand.map((cardId) => {
      const card = getCard(cardId)!
      const isDrawn = drawnId === null ? false : cardId === drawnId
      const playable = isHumanTurn.value && isPlayableForHuman(game, cardId)
      return {
        card,
        playable,
        reason: playable ? null : unplayableReason(game, cardId),
        isDrawn,
      }
    })
  })

  function isPlayableForHuman(game: GameState, cardId: string): boolean {
    if (!isHumanTurn.value) {
      return false
    }
    if (game.phase.kind === 'after-draw') {
      return cardId === game.phase.drawnCardId
    }
    if (game.phase.kind !== 'turn') {
      return false
    }
    const card = getCard(cardId)
    if (!card) {
      return false
    }
    const hand = game.players[0]!.hand
    const top = getCard(game.discardPile[game.discardPile.length - 1]!)!
    const currentColor = game.currentColor!
    if (card.color !== null) {
      if (card.color === currentColor) {
        return true
      }
      if (isWildKind(top.kind)) {
        return false
      }
      return top.kind === card.kind && (card.kind !== 'number' || top.value === card.value)
    }
    if (card.kind === 'wild') {
      return true
    }
    return !hand.some(id => getCard(id)?.color === currentColor)
  }

  function unplayableReason(game: GameState, cardId: string): string {
    if (!isHumanTurn.value) {
      return '当前不是你的回合'
    }
    if (game.phase.kind === 'after-draw') {
      return '抽牌后只能出刚抽到的这张牌'
    }
    const card = getCard(cardId)!
    if (card.kind === 'wild-draw-four') {
      return '手中有与当前颜色相同的牌，不能出 +4'
    }
    return '与当前颜色和顶牌均不匹配'
  }

  // ---- 真人动作意图 --------------------------------------------------------
  function playCard(cardId: string, chosenColor: Color | undefined, declareUno: boolean) {
    enqueue(() => {
      const action: LegalAction = chosenColor === undefined
        ? { type: 'play', cardId, declareUno }
        : { type: 'play', cardId, chosenColor, declareUno }
      submitAction('p0', action)
    })
  }

  function drawOne() {
    enqueue(() => submitAction('p0', { type: 'draw-one' }))
  }

  function keepDrawn() {
    enqueue(() => submitAction('p0', { type: 'keep-drawn' }))
  }

  function chooseOpeningColor(color: Color) {
    enqueue(() => submitAction('p0', { type: 'choose-opening-color', color }))
  }

  // 公开事件（最近若干条，倒序展示最新）
  const recentEvents = computed<PublicEvent[]>(() => {
    const events = state.value?.recentEvents ?? []
    return [...events].reverse()
  })

  return {
    // 会话
    status,
    controlMode,
    entrySave,
    slotProblemKind,
    actionError,
    dismissActionError,
    initialize,
    tryTakeControl,
    startNewGame,
    currentSlotSignature,
    slotNeedsConfirmation,
    continueGame,
    startTempGame,
    clearInvalidSaveAndStart,
    reloadFromSlot,
    retrySave,
    continueInMemoryOnly,
    exitToEntry,
    // 状态与派生
    state,
    /** 浏览器存储是否可访问（不可用时入口明确提供不保存的临时对局）。 */
    storageAvailable: persistence.storageAvailable,
    humanPlayer,
    opponents,
    topCard,
    isHumanTurn,
    phaseKind,
    drawnCardId,
    handCards,
    recentEvents,
    // 真人动作
    playCard,
    drawOne,
    keepDrawn,
    chooseOpeningColor,
    // 持久化与 AI 状态
    persistence,
    aiTurn,
    lock,
    writerId,
  }
}
