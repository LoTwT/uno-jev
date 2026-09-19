import type { Ref } from 'vue'
import type { AiDecisionRequest, AiDecisionResponse, AiErrorResponse } from '#shared/ai/protocol'
import type { Candidate, DecisionSource, FallbackReason, GameState, LegalAction, PlayerId } from '#shared/game'
/**
 * AI 回合调度：生成当前 AI 视角、发起一次决策、校验过期响应、执行规则兜底并标记来源。
 *
 * 每个决策最多一次上游请求；同一页面最多一个在途决策；
 * 应用响应前同时校验锁、可推进状态、decisionId、gameId、revision、行动者与阶段；
 * 先使本请求失效，再提交一次动作，晚到的成功或失败均无权覆盖结果。
 * 页面隐藏时取消在途请求并作废代次；恢复可见后按当前持久状态重新调度（规格：AI 决策协议）。
 */
import { onBeforeUnmount, readonly, ref, shallowRef } from 'vue'
import {
  buildDecisionContextFromState,
  chooseFallbackAction,
  enumerateCandidatesFromState,
  projectForAi,
} from '#shared/game'

/** 浏览器同源请求默认总计 8 秒超时（产品等待预算，不是已测性能）。 */
export const BROWSER_DECISION_TIMEOUT_MS = 8000
/** 429 后默认冷却 30 秒；更长的有效 Retry-After 优先。 */
export const RATE_LIMIT_COOLDOWN_MS = 30_000

export type AiActorId = 'p1' | 'p2' | 'p3'

export interface AiTurnDeps {
  getState: () => GameState | null
  /** 页面可推进：持有控制权、页面可见、存档健康、会话处于进行中。 */
  canAdvance: () => boolean
  /** 串行提交动作；返回是否成功落地。 */
  submitAction: (actorId: PlayerId, action: LegalAction, meta: { aiSource: DecisionSource, fallbackReason?: FallbackReason }) => boolean
  /** 浏览器同源请求超时；默认 8 秒产品等待预算。 */
  timeoutMs?: number
  /** 开发诊断日志（仅控制台，不含密钥或暗牌）。 */
  devLog?: (message: string) => void
}

export interface InFlightDecision {
  decisionId: string
  gameId: string
  revision: number
  actorId: AiActorId
  phaseKind: 'turn' | 'after-draw' | 'opening-color'
}

export interface AiTurnController {
  /** 是否有在途请求（用于 UI 的"思考中"标识）。 */
  inFlight: Readonly<Ref<InFlightDecision | null>>
  /** 冷却截止时间戳（ms）；期间各次 AI 行动使用规则兜底。 */
  cooldownUntil: Readonly<Ref<number>>
  /** 503 后本页面会话暂停 Jev 请求；提供"重试 AI"入口恢复。 */
  jevPaused: Readonly<Ref<boolean>>
  schedule: () => void
  /** 取消在途请求并作废代次（隐藏、失锁、换局、销毁时调用）。 */
  cancelAll: () => void
  /** 用户点击"重试 AI"：恢复后续决策，不重放已落地动作。 */
  resumeJev: () => void
}

export function useAiTurn(deps: AiTurnDeps): AiTurnController {
  /** 请求代次：仅在取消 / 失效时递增；响应携带的代次不匹配即丢弃。 */
  let generation = 0
  const inFlight = shallowRef<InFlightDecision | null>(null)
  const cooldownUntil = ref(0)
  const jevPaused = ref(false)
  let abortController: AbortController | null = null
  const log = deps.devLog ?? (() => {})

  function invalidate() {
    generation++
    inFlight.value = null
    if (abortController !== null) {
      abortController.abort()
      abortController = null
    }
  }

  function cancelAll() {
    if (inFlight.value !== null || abortController !== null) {
      log('取消在途 AI 决策并作废代次')
    }
    invalidate()
  }

  function resumeJev() {
    jevPaused.value = false
    schedule()
  }

  function runFallback(actor: AiActorId, reason: FallbackReason) {
    invalidate()
    const state = deps.getState()
    if (!state || state.currentPlayerId !== actor || state.phase.kind === 'finished') {
      return
    }
    const ctx = buildDecisionContextFromState(state)
    const candidates = enumerateCandidatesFromState(state)
    if (!ctx || !candidates) {
      log(`兜底中止：状态不可决策（${actor}）`)
      return
    }
    const choice = chooseFallbackAction(ctx, candidates)
    if (!choice) {
      return
    }
    deps.submitAction(actor, choice.action, { aiSource: 'fallback', fallbackReason: reason })
  }

  async function startRequest(state: GameState, actor: AiActorId, candidates: Candidate[]) {
    const decisionId = crypto.randomUUID()
    const requestGeneration = generation
    inFlight.value = {
      decisionId,
      gameId: state.gameId,
      revision: state.revision,
      actorId: actor,
      phaseKind: state.phase.kind as InFlightDecision['phaseKind'],
    }
    const controller = new AbortController()
    abortController = controller
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? BROWSER_DECISION_TIMEOUT_MS)

    const request: AiDecisionRequest = {
      protocolVersion: 1,
      rulesVersion: 'classic-single-v1',
      gameId: state.gameId,
      revision: state.revision,
      decisionId,
      actorId: actor,
      view: projectForAi(state, actor),
      candidates,
    }

    try {
      const response = await fetch('/api/ai/decision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: controller.signal,
      })
      // 旧请求 / 重复响应 / 已换局或已失去控制权：丢弃，不执行也不兜底
      if (requestGeneration !== generation) {
        log(`丢弃过期响应（${decisionId}）`)
        return
      }
      if (!response.ok) {
        let body: AiErrorResponse | null = null
        try {
          body = await response.json() as AiErrorResponse
        }
        catch {
          body = null
        }
        if (requestGeneration !== generation) {
          return
        }
        handleFailure(response.status, response.headers.get('retry-after'), body, actor)
        return
      }
      const data = await response.json() as AiDecisionResponse
      if (requestGeneration !== generation) {
        return
      }
      applySuccess(data, actor)
    }
    catch (error) {
      if (requestGeneration !== generation) {
        return
      }
      // 浏览器网络错误、8 秒到期：取消请求，当次兜底
      const reason: FallbackReason = controller.signal.aborted ? 'timeout' : 'network_error'
      log(`AI 请求失败（${reason}）：${error instanceof Error ? error.message : String(error)}`)
      runFallback(actor, reason)
    }
    finally {
      clearTimeout(timer)
      if (abortController === controller) {
        abortController = null
      }
    }
  }

  function handleFailure(status: number, retryAfterHeader: string | null, body: AiErrorResponse | null, actor: AiActorId) {
    const code = body?.error?.code
    if (status === 429 || code === 'ai_rate_limited') {
      // 客户端至少冷却 30 秒；更长的有效 Retry-After 优先
      const retrySeconds = Number.parseInt(retryAfterHeader ?? '', 10)
      const cooldownMs = Number.isSafeInteger(retrySeconds) && retrySeconds > 0
        ? Math.max(RATE_LIMIT_COOLDOWN_MS, retrySeconds * 1000)
        : RATE_LIMIT_COOLDOWN_MS
      cooldownUntil.value = Date.now() + cooldownMs
      runFallback(actor, 'rate_limited')
      return
    }
    if (status === 503 || code === 'ai_unavailable') {
      // 缺 key / 上游 401/403：本页面会话暂停 Jev 请求
      jevPaused.value = true
      runFallback(actor, 'ai_unavailable')
      return
    }
    if (code === 'ai_invalid_response') {
      runFallback(actor, 'invalid_response')
      return
    }
    if (code === 'ai_timeout') {
      runFallback(actor, 'timeout')
      return
    }
    if (code === 'ai_upstream_error') {
      runFallback(actor, 'upstream_error')
      return
    }
    // 400 合同错误：客户端重新验证当前状态与合法动作，通过则当次兜底
    if (code === 'invalid_request' || code === 'forbidden_origin' || status === 400 || status === 403) {
      runFallback(actor, 'invalid_request')
      return
    }
    // 错误页不是 JSON 等情况：按网络 / HTTP 失败处理
    runFallback(actor, status >= 500 ? 'upstream_error' : 'network_error')
  }

  function applySuccess(data: AiDecisionResponse, actor: AiActorId) {
    const flight = inFlight.value
    const state = deps.getState()
    if (!flight || !state) {
      return
    }
    // 关联字段全部匹配才可用
    if (
      data.decisionId !== flight.decisionId
      || data.gameId !== flight.gameId
      || data.revision !== flight.revision
      || data.actorId !== flight.actorId
      || data.protocolVersion !== 1
      || data.source !== 'jev'
    ) {
      log(`响应关联字段不匹配，丢弃（${data.decisionId}）`)
      runFallback(actor, 'invalid_response')
      return
    }
    // 当前状态仍须与请求快照一致
    if (state.gameId !== flight.gameId || state.revision !== flight.revision || state.currentPlayerId !== actor) {
      log('状态已变化，丢弃响应')
      return
    }
    // 以当前状态重新枚举合法动作，用 ID 查找
    const candidates = enumerateCandidatesFromState(state)
    const chosen = candidates?.find(candidate => candidate.id === data.actionId)
    if (!chosen) {
      log(`actionId 不在当前候选中（${data.actionId}）`)
      runFallback(actor, 'invalid_response')
      return
    }
    // 先使本请求失效，再提交一次动作
    invalidate()
    deps.submitAction(actor, chosen.action, { aiSource: 'jev' })
  }

  function schedule() {
    if (inFlight.value !== null) {
      return
    }
    const state = deps.getState()
    if (!state || state.phase.kind === 'finished') {
      return
    }
    if (state.currentPlayerId === 'p0') {
      return
    }
    if (!deps.canAdvance()) {
      return
    }
    const actor = state.currentPlayerId as AiActorId
    const candidates = enumerateCandidatesFromState(state)
    if (!candidates || candidates.length === 0) {
      // 应可行动却没有候选属于引擎错误：暂停并报告，不凭空构造出牌
      log(`引擎错误：${actor} 应可行动但没有候选动作`)
      return
    }
    if (candidates.length === 1) {
      // 只有 1 个候选时直接执行并记为 forced，不调用 Jev
      deps.submitAction(actor, candidates[0]!.action, { aiSource: 'forced' })
      return
    }
    if (jevPaused.value) {
      runFallback(actor, 'ai_unavailable')
      return
    }
    if (cooldownUntil.value > Date.now()) {
      runFallback(actor, 'rate_limited')
      return
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      // 离线期间直接兜底；恢复网络后的新决策再尝试
      runFallback(actor, 'offline')
      return
    }
    void startRequest(state, actor, candidates)
  }

  onBeforeUnmount(() => {
    cancelAll()
  })

  return {
    inFlight,
    cooldownUntil: readonly(cooldownUntil),
    jevPaused: readonly(jevPaused),
    schedule,
    cancelAll,
    resumeJev,
  }
}
