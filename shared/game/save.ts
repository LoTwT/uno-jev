/**
 * 浏览器存档 envelope：加载校验与序列化。
 *
 * v1 只读取 schemaVersion: 1 与 classic-single-v1 的组合；
 * 本仓库没有旧游戏格式，因此不编写虚构迁移。
 * 未知版本、缺字段、坏 JSON 或不自洽存档一律返回失败，由调用方保留原槽位，
 * 不能用 mergeDefaults 默默补全缺失的游戏字段（规格：浏览器持久化）。
 */
import type { GameState } from './types'
import { UUID_PATTERN, validateState } from './engine'

export const SAVE_SCHEMA_VERSION = 1

export interface SaveEnvelopeV1 {
  schemaVersion: typeof SAVE_SCHEMA_VERSION
  /** ISO 8601，仅用于显示，不用于解决冲突。 */
  savedAt: string
  /** 本页面随机标识，不是账号或设备标识。 */
  writerId: string
  state: GameState
}

export type SaveLoadFailureReason = 'absent' | 'invalid-json' | 'invalid-shape' | 'invalid-state'

export type SaveLoadResult
  = | { ok: true, envelope: SaveEnvelopeV1 }
    | { ok: false, reason: SaveLoadFailureReason, message: string, errors?: string[] }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 读取并校验存档原始 JSON。
 * 通过后才能进入可交互状态；失败时保留原槽位由用户选择处理方式。
 */
export function loadSaveEnvelope(raw: string | null): SaveLoadResult {
  if (raw === null || raw === '') {
    return { ok: false, reason: 'absent', message: '没有存档' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch {
    return { ok: false, reason: 'invalid-json', message: '存档不是有效 JSON' }
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, reason: 'invalid-shape', message: '存档结构不是对象' }
  }
  if (parsed.schemaVersion !== SAVE_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: 'invalid-shape',
      message: `未知存档版本: ${String(parsed.schemaVersion)}（本版本只支持 ${SAVE_SCHEMA_VERSION}）`,
    }
  }
  if (typeof parsed.savedAt !== 'string' || parsed.savedAt.length === 0 || parsed.savedAt.length > 40) {
    return { ok: false, reason: 'invalid-shape', message: 'savedAt 必须是字符串' }
  }
  if (typeof parsed.writerId !== 'string' || !UUID_PATTERN.test(parsed.writerId)) {
    return { ok: false, reason: 'invalid-shape', message: 'writerId 必须是 UUID' }
  }
  if (!isPlainObject(parsed.state)) {
    return { ok: false, reason: 'invalid-shape', message: 'state 必须是对象' }
  }
  const stateCheck = validateState(parsed.state)
  if (!stateCheck.ok) {
    return { ok: false, reason: 'invalid-state', message: '存档状态不自洽', errors: stateCheck.errors }
  }
  return { ok: true, envelope: parsed as unknown as SaveEnvelopeV1 }
}

/** 序列化 envelope；写入槽位的唯一格式。 */
export function serializeSaveEnvelope(envelope: SaveEnvelopeV1): string {
  return JSON.stringify(envelope)
}
