/**
 * 同源 AI 决策接口合同：浏览器 ↔ Worker 的请求 / 响应 / 错误形状。
 *
 * 不接收完整 GameState、任意提示词、上游地址或用户指定模型（规格：同源 API 合同）。
 */
import type { AiView } from '../game/aiView'
import type { Candidate } from '../game/candidates'
import type { LegalAction } from '../game/types'

export const AI_PROTOCOL_VERSION = 2
export const AI_RULES_VERSION = 'classic-single-v1'

/**
 * 个人 Key 通过同源 HTTPS 请求的专用请求头传递（不进请求体、URL 或存档）。
 * Worker 仅在当前请求中使用该值，不写入服务端存储、全局变量或缓存。
 */
export const AI_PERSONAL_KEY_HEADER = 'x-unojev-personal-key'

/** 个人 Key 长度上限；仅约束形状，不预设具体 Key 格式。 */
export const AI_PERSONAL_KEY_MAX_LENGTH = 256
/** 个人 Key 允许的可打印 ASCII（不含空格与控制字符）；HTTP 头安全字符集。 */
export const AI_PERSONAL_KEY_PATTERN = /^[\x21-\x7E]+$/

/** 请求体上限 64 KiB。 */
export const AI_REQUEST_BODY_LIMIT_BYTES = 64 * 1024
/** 候选数量上限（100 有色 + 8 Wild × 4 色 + 1 抽牌）。 */
export const AI_MAX_CANDIDATES = 133
export const AI_MIN_CANDIDATES = 2
/** 候选 ID 上限 128 字符 ASCII 标识（小写字母、数字、下划线、连字符；牌 ID 本身含连字符）。 */
export const AI_CANDIDATE_ID_MAX_LENGTH = 128
export const AI_CANDIDATE_ID_PATTERN = /^[a-z0-9_-]+$/

export type AiActorId = 'p1' | 'p2' | 'p3'

/** 凭据来源：站点密钥（服务端 runtimeConfig）或用户主动提供的个人 Key（请求头）。 */
export type AiCredentialSource = 'site' | 'personal'

export interface AiDecisionRequest {
  protocolVersion: typeof AI_PROTOCOL_VERSION
  rulesVersion: typeof AI_RULES_VERSION
  /** 本次决策使用的凭据来源；personal 时必须携带专用请求头。 */
  credentialSource: AiCredentialSource
  gameId: string
  revision: number
  /** 每次请求的新 UUID，仅当前页面内存记录它与请求快照的对应关系。 */
  decisionId: string
  actorId: AiActorId
  view: AiView
  candidates: Array<{ id: string, action: LegalAction }>
}

export interface AiDecisionResponse {
  protocolVersion: typeof AI_PROTOCOL_VERSION
  gameId: string
  revision: number
  decisionId: string
  actorId: AiActorId
  actionId: string
  source: 'jev'
  /** 上游实际响应的模型名。 */
  model: string
}

export type AiErrorCode
  = | 'invalid_request'
    | 'forbidden_origin'
    | 'ai_rate_limited'
    /** 上游 529：TypeSafe 暂时过载（区别于 429 的调用方限流）。 */
    | 'ai_overloaded'
    | 'ai_unavailable'
    /** 个人 Key 被上游拒绝（401/403）：问题归属于用户自己的 Key。 */
    | 'ai_key_rejected'
    /**
     * 站点额度已确认耗尽：仅由运营者显式配置触发（TypeSafe API 无额度耗尽信号，
     * 不得从 429/529/鉴权错误猜测），个人 Key 请求不受影响。
     */
    | 'ai_site_quota_exhausted'
    | 'ai_invalid_response'
    | 'ai_upstream_error'
    | 'ai_timeout'

export interface AiErrorResponse {
  error: { code: AiErrorCode }
  decisionId?: string
}

export type AiDecisionResult = AiDecisionResponse | AiErrorResponse

export function isAiErrorResponse(value: AiDecisionResult): value is AiErrorResponse {
  return 'error' in value
}

export { type AiView, type Candidate, type LegalAction }
