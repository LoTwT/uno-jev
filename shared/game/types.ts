/**
 * UnoJev 规则层领域模型。
 *
 * 全部数据可 JSON 序列化，判别联合表达阶段与动作；
 * 不依赖 Vue、DOM、storage、网络或系统时钟（规格：领域模型与状态机）。
 */

/** 四种游戏颜色；顺序固定为红、黄、绿、蓝，用于候选排序与选色面板。 */
export type Color = 'red' | 'yellow' | 'green' | 'blue'

export const COLORS: readonly Color[] = ['red', 'yellow', 'green', 'blue'] as const

/** 座位顺序固定为 p0..p3；p0 为真人，p1..p3 为 Jev AI。 */
export type PlayerId = 'p0' | 'p1' | 'p2' | 'p3'

export const PLAYER_IDS: readonly PlayerId[] = ['p0', 'p1', 'p2', 'p3'] as const

/** 牌面类型；数字 0..9，功能牌与 Wild 类见规格"游戏规则"。 */
export type CardKind = 'number' | 'skip' | 'reverse' | 'draw-two' | 'wild' | 'wild-draw-four'

/**
 * 稳定牌 ID，由牌组目录（cards.ts）保证有效；
 * ID 不编码洗牌后的顺序，同面值的两张牌是不同实例。
 */
export type CardId = string

export interface Card {
  id: CardId
  kind: CardKind
  /** Wild 类无固有颜色，为 null。 */
  color: Color | null
  /** 仅数字牌有值 0..9，其余为 null。 */
  value: number | null
}

export type PlayerType = 'human' | 'jev'

export interface Player {
  id: PlayerId
  type: PlayerType
  /** 显示名称（如"你"、"Jev 1"），持久化于状态中。 */
  name: string
  /** 完整有序手牌；顺序为获得顺序，仅用于展示与候选枚举稳定性。 */
  hand: CardId[]
  /** 已结算的 UNO 宣告；仅剩 1 张时可为 true，抽牌后清除。 */
  unoDeclared: boolean
}

export type FinishedResult
  = | { reason: 'empty-hand', winnerId: PlayerId }
    | { reason: 'blocked', winnerId: null }

export type GamePhase
  = | { kind: 'opening-color' }
    | { kind: 'turn' }
    | { kind: 'after-draw', drawnCardId: CardId }
    | { kind: 'finished', result: FinishedResult }

/** 规则层合法动作；`chosenColor` 对 Wild 类必填、对有色牌禁止。 */
export type LegalAction
  = | { type: 'play', cardId: CardId, chosenColor?: Color, declareUno: boolean }
    | { type: 'draw-one' }
    | { type: 'keep-drawn' }
    | { type: 'choose-opening-color', color: Color }

/** 抽牌原因，用于公开日志。 */
export type DrawReason
  = | 'turn'
    | 'draw-two'
    | 'wild-draw-four'
    | 'uno-miss'
    | 'opening-draw-two'

/** 跳过原因，用于公开日志。 */
export type SkipReason
  = | 'skip'
    | 'draw-two'
    | 'wild-draw-four'
    | 'opening-skip'
    | 'opening-draw-two'

/** AI 决策来源；由会话层写入，规则引擎只负责记录。 */
export type DecisionSource = 'jev' | 'forced' | 'fallback'

/** 兜底原因码；与规格"超时、兜底与过期响应"的错误表对应。 */
export type FallbackReason
  = | 'invalid_request'
    | 'rate_limited'
    | 'service_overloaded'
    | 'ai_unavailable'
    | 'site_quota_exhausted'
    | 'personal_key_missing'
    | 'personal_key_rejected'
    | 'invalid_response'
    | 'upstream_error'
    | 'timeout'
    | 'network_error'
    | 'offline'

/**
 * 公开事件：可展示、可发给 AI 视角的日志。
 * 不记录抽到的暗牌牌面，只记录数量（含应抽数与实抽数）。
 */
export type PublicEvent
  = | { revision: number, type: 'game-started', dealerId: PlayerId, openingCardId: CardId }
    | { revision: number, type: 'opening-color-chosen', playerId: PlayerId, color: Color }
    | { revision: number, type: 'card-played', playerId: PlayerId, cardId: CardId, chosenColor?: Color }
    | { revision: number, type: 'direction-reversed', byPlayerId: PlayerId }
    | { revision: number, type: 'uno-declared', playerId: PlayerId }
    | { revision: number, type: 'uno-miss-caught', playerId: PlayerId, caughtBy: PlayerId, penaltyCount: number }
    | { revision: number, type: 'cards-drawn', playerId: PlayerId, requested: number, drawn: number, reason: DrawReason }
    | { revision: number, type: 'player-skipped', playerId: PlayerId, reason: SkipReason }
    | { revision: number, type: 'pile-reshuffled', recycledCount: number }
    | { revision: number, type: 'kept-drawn', playerId: PlayerId }
    | { revision: number, type: 'decision-source', playerId: PlayerId, source: DecisionSource, reason?: FallbackReason }
    | { revision: number, type: 'game-finished', result: FinishedResult }

export interface GameState {
  /** 每次新局生成新 UUID，不跨新局复用。 */
  gameId: string
  /** 固定为 classic-single-v1，覆盖本规格中的明确取舍。 */
  rulesVersion: 'classic-single-v1'
  /** 从 0 开始，每次成功提交动作加 1；同一动作内的连带结算只加一次。 */
  revision: number
  players: Player[]
  dealerId: PlayerId
  /** 完整有序；末项先抽。 */
  drawPile: CardId[]
  /** 完整有序；末项为顶牌，始终非空。 */
  discardPile: CardId[]
  /** 仅 opening-color 阶段可为 null。 */
  currentColor: Color | null
  direction: 1 | -1
  /** 当前行动者；结束阶段保留最后行动者，仅供显示。 */
  currentPlayerId: PlayerId
  phase: GamePhase
  /** 连续抽不到牌且未出牌的正常回合数；运行中为 0..3，第 4 次转入和局。 */
  blockedTurnCount: number
  /** 最多 50 条公开事件；不是完整回放。 */
  recentEvents: PublicEvent[]
}

/** 动作提交合同：actorId、gameId、expectedRevision 全部携带，不匹配即拒绝。 */
export interface ActionSubmission {
  actorId: PlayerId
  gameId: string
  expectedRevision: number
  action: LegalAction
}

/** 会话层附加的决策来源信息，由引擎在原子结算内记录为公开事件。 */
export interface ActionMeta {
  aiSource?: DecisionSource
  fallbackReason?: FallbackReason
}

export type ActionErrorCode
  = | 'game-id-mismatch'
    | 'stale-revision'
    | 'not-your-turn'
    | 'invalid-phase'
    | 'unknown-action'
    | 'card-not-in-hand'
    | 'card-not-playable'
    | 'invalid-chosen-color'
    | 'invalid-uno-declaration'
    | 'not-drawn-card'

export type ApplyActionResult
  = | { ok: true, state: GameState, events: PublicEvent[] }
    | { ok: false, error: ActionErrorCode, message: string }

export type ValidationResult
  = | { ok: true }
    | { ok: false, errors: string[] }
