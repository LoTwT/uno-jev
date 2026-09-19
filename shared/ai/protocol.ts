/**
 * 同源 AI 决策接口合同：浏览器 ↔ Worker 的请求 / 响应 / 错误形状。
 *
 * 不接收完整 GameState、任意提示词、上游地址或用户指定模型（规格：同源 API 合同）。
 */
import type { AiView } from '../game/aiView'
import type { Candidate } from '../game/candidates'
import type { LegalAction } from '../game/types'

export const AI_PROTOCOL_VERSION = 1
export const AI_RULES_VERSION = 'classic-single-v1'

/** 请求体上限 64 KiB。 */
export const AI_REQUEST_BODY_LIMIT_BYTES = 64 * 1024
/** 候选数量上限（100 有色 + 8 Wild × 4 色 + 1 抽牌）。 */
export const AI_MAX_CANDIDATES = 133
export const AI_MIN_CANDIDATES = 2
/** 候选 ID 上限 128 字符 ASCII 标识（小写字母、数字、下划线、连字符；牌 ID 本身含连字符）。 */
export const AI_CANDIDATE_ID_MAX_LENGTH = 128
export const AI_CANDIDATE_ID_PATTERN = /^[a-z0-9_-]+$/

export type AiActorId = 'p1' | 'p2' | 'p3'

export interface AiDecisionRequest {
  protocolVersion: typeof AI_PROTOCOL_VERSION
  rulesVersion: typeof AI_RULES_VERSION
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
    | 'ai_unavailable'
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
