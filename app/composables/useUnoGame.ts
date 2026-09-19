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
import type { InitialLoad } from './useGamePersistence'
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
import { useGamePersistence } from './useGamePersistence'

export type SessionStatus
  = | 'boot'
    | 'entry'
    | 'playing'
    | 'readonly-locked'
    | 'no-lock-browser'
    | 'invalid-save'
    | 'slot-conflict'

export type ControlMode = 'locked' | 'temp'

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

  /** 是否允许自动推进 AI（页面可见、持锁 / 临时模式、存档未失败）。 */
  function canAdvance(): boolean {
    if (status.value !== 'playing') {
      return false
    }
    if (controlMode.value === 'locked' && !lock.held.value) {
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
  let queue: Promise<void> = Promise.resolve()
  function enqueue(run: () => void) {
    queue = queue.then(run).catch((error) => {
      console.error('[unojev] 命令执行异常:', error)
    })
  }

  // ---- 保存与冲突 ---------------------------------------------------------
  function persistCurrent(): boolean {
    if (controlMode.value === 'temp' || persistence.saveHealth.value === 'memory-only') {
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
    if (controlMode.value === 'locked' && !lock.held.value) {
      return false
    }
    // 持锁期间比较持久化槽位与最后成功读取 / 保存的签名
    if (controlMode.value === 'locked' && persistence.saveHealth.value !== 'memory-only') {
      const verify = persistence.verifySlot()
      if (verify !== 'ok') {
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
    entrySave.value = persistence.loadInitial()
    if (entrySave.value.status === 'invalid') {
      status.value = 'invalid-save'
      return
    }
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
      entrySave.value = persistence.loadInitial()
      status.value = entrySave.value.status === 'invalid' ? 'invalid-save' : 'entry'
    }
    else {
      entrySave.value = persistence.readForDisplay()
    }
  }

  /** 入口操作前确保持有控制权（返回入口释放后可重新争取）。 */
  async function ensureControl(): Promise<boolean> {
    if (controlMode.value === 'temp') {
      return true
    }
    if (lock.held.value) {
      return true
    }
    // 重新争取锁；失败（其他标签页仍持有）时保持入口/只读状态
    const granted = await lock.request()
    if (!granted) {
      entrySave.value = persistence.readForDisplay()
      status.value = webLocksSupported() ? 'readonly-locked' : 'no-lock-browser'
    }
    return granted
  }

  function startNewGame() {
    void enqueue(async () => {
      if (!(await ensureControl())) {
        return
      }
      aiTurn.cancelAll()
      const game = createGame({ gameId: freshUuid() })
      state.value = game
      status.value = 'playing'
      // 立即保存首个快照；失败时暂停自动推进并呈现重试入口
      persistCurrent()
      aiTurn.schedule()
    })
  }

  function continueGame() {
    void enqueue(async () => {
      if (!(await ensureControl())) {
        return
      }
      let envelope = entrySave.value.status === 'valid' ? entrySave.value.envelope : undefined
      if (!envelope) {
        // 入口的存档引用可能过期，重新读取一次
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

  /** 存档无法读取时：用户确认清除并新开一局。 */
  function clearInvalidSaveAndStart() {
    enqueue(() => {
      persistence.clearSlot()
      entrySave.value = { status: 'absent' }
      startNewGame()
    })
  }

  function reloadFromSlot() {
    void enqueue(async () => {
      if (!(await ensureControl())) {
        return
      }
      aiTurn.cancelAll()
      entrySave.value = persistence.loadInitial()
      if (entrySave.value.status === 'valid' && entrySave.value.envelope) {
        state.value = entrySave.value.envelope.state
        status.value = 'playing'
        slotProblemKind.value = null
        aiTurn.schedule()
      }
      else if (entrySave.value.status === 'invalid') {
        status.value = 'invalid-save'
      }
      else {
        // 槽位被外部删除且无内容可载入：回到入口
        state.value = null
        status.value = 'entry'
      }
    })
  }

  function retrySave() {
    enqueue(() => {
      if (state.value === null) {
        return
      }
      // 重试前检查旧槽位仍匹配本页最后成功保存的签名；不匹配按冲突处理
      if (persistence.retrySave(state.value, writerId)) {
        aiTurn.schedule()
      }
      else {
        handleSlotProblem(persistence.verifySlot() === 'ok' ? 'storage-error' : 'conflict')
      }
    })
  }

  function continueInMemoryOnly() {
    enqueue(() => {
      persistence.enterMemoryOnly()
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
      entrySave.value = persistence.loadInitial()
      status.value = entrySave.value.status === 'invalid' ? 'invalid-save' : 'entry'
    })
  }

  function dismissActionError() {
    actionError.value = null
  }

  // ---- 页面可见性 ---------------------------------------------------------
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
    continueGame,
    startTempGame,
    clearInvalidSaveAndStart,
    reloadFromSlot,
    retrySave,
    continueInMemoryOnly,
    exitToEntry,
    // 状态与派生
    state,
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
