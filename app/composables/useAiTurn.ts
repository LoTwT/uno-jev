import type { Ref } from 'vue'
import type { AiDecisionRequest, AiDecisionResponse, AiErrorResponse } from '#shared/ai/protocol'
import type { Candidate, DecisionSource, FallbackReason, GameState, LegalAction, PlayerId } from '#shared/game'
import type { JevCredential } from './useJevCredentials'
/**
 * AI 回合调度：生成当前 AI 视角、发起一次决策、校验过期响应、执行规则兜底并标记来源。
 *
 * 凭据感知（K 系）：
 * - 每个决策按当前凭据来源发起请求；个人 Key 经专用请求头传递，绝不写入请求体。
 * - 暂停与限流冷却按凭据来源分别记录：站点额度故障不能阻止个人 Key 使用；
 *   个人 Key 缺失或被拒绝时不得悄悄改用站点额度，也不得自动轮换 Key 重试。
 * - 站点额度确认耗尽为会话内粘滞状态（只对站点来源生效），切换来源不重置。
 * - 凭据变更（保存 / 替换 / 删除 Key、切换来源）时取消并作废旧请求，
 *   旧请求的成功与失败都不能影响新配置；替换 Key 后清除个人来源的暂停与冷却。
 *
 * 其余约束不变：每个决策最多一次上游请求；同一页面最多一个在途决策；
 * 应用响应前同时校验锁、可推进状态、decisionId、gameId、revision、行动者与阶段；
 * 先使本请求失效，再提交一次动作，晚到的成功或失败均无权覆盖结果。
 */
import { computed, onBeforeUnmount, readonly, ref, shallowRef } from 'vue'
import { AI_PERSONAL_KEY_HEADER, AI_PROTOCOL_VERSION, AI_RULES_VERSION } from '#shared/ai/protocol'
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

/** 个人来源暂停的具体原因；决定界面提示与恢复方式。 */
export type PersonalPauseReason = 'key_rejected' | 'unavailable'

export interface AiTurnDeps {
  getState: () => GameState | null
  /** 页面可推进：持有控制权、页面可见、存档健康、会话处于进行中。 */
  canAdvance: () => boolean
  /** 当前凭据快照：来源与个人 Key（personal 时非空才发起请求）。 */
  getCredential: () => JevCredential
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
  /** 本请求使用的凭据来源；失败按此归属暂停 / 冷却。 */
  credentialSource: 'site' | 'personal'
}

/** 按凭据来源区分的调度状态。 */
interface CredentialRuntimeState {
  cooldownUntil: { site: number, personal: number }
  paused: { site: boolean, personal: boolean }
  personalPauseReason: PersonalPauseReason | null
}

export interface AiTurnController {
  /** 是否有在途请求（用于 UI 的"思考中"标识）。 */
  inFlight: Readonly<Ref<InFlightDecision | null>>
  /** 当前凭据来源的冷却截止时间戳（ms）；期间各次 AI 行动使用规则兜底。 */
  cooldownUntil: Readonly<Ref<number>>
  /** 当前凭据来源是否暂停 Jev 请求；提供"重试 AI"入口恢复。 */
  jevPaused: Readonly<Ref<boolean>>
  /** 个人来源暂停原因（key_rejected：Key 无效或无权限；unavailable：服务端配置等）。 */
  personalPauseReason: Readonly<Ref<PersonalPauseReason | null>>
  /** 站点额度确认耗尽（会话内粘滞，仅影响站点来源；个人 Key 不受影响）。 */
  siteQuotaExhausted: Readonly<Ref<boolean>>
  schedule: () => void
  /** 取消在途请求并作废代次（隐藏、失锁、换局、销毁时调用）。 */
  cancelAll: () => void
  /** 用户点击"重试 AI"：恢复当前来源的后续决策，不重放已落地动作。 */
  resumeJev: () => void
  /**
   * 凭据变更（保存 / 替换 / 删除 Key、切换来源）后调用：
   * 作废在途请求；替换或删除 Key 后清除个人来源的暂停与冷却，再按当前状态重新调度。
   */
  onCredentialsChanged: () => void
}

export function useAiTurn(deps: AiTurnDeps): AiTurnController {
  /** 请求代次：仅在取消 / 失效时递增；响应携带的代次不匹配即丢弃。 */
  let generation = 0
  const inFlight = shallowRef<InFlightDecision | null>(null)
  const runtime = ref<CredentialRuntimeState>({
    cooldownUntil: { site: 0, personal: 0 },
    paused: { site: false, personal: false },
    personalPauseReason: null,
  })
  const siteQuotaExhausted = ref(false)
  let abortController: AbortController | null = null
  const log = deps.devLog ?? (() => {})

  /** 最近一次见过的凭据快照；用于识别 Key 内容变化。 */
  let lastCredential: JevCredential | null = null

  const cooldownUntil = computed(() => runtime.value.cooldownUntil[deps.getCredential().source])
  const jevPaused = computed(() => runtime.value.paused[deps.getCredential().source])

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
    const source = deps.getCredential().source
    runtime.value = {
      ...runtime.value,
      paused: { ...runtime.value.paused, [source]: false },
      personalPauseReason: source === 'personal' ? null : runtime.value.personalPauseReason,
    }
    schedule()
  }

  function onCredentialsChanged() {
    const next = deps.getCredential()
    const previous = lastCredential
    lastCredential = { ...next }
    // 旧请求的成功与失败都不能影响新配置：先作废在途请求
    cancelAll()
    if (previous !== null && previous.personalKey !== next.personalKey) {
      // 替换或删除 Key：个人来源的暂停与冷却针对旧 Key，对新 Key 无意义
      runtime.value = {
        ...runtime.value,
        cooldownUntil: { ...runtime.value.cooldownUntil, personal: 0 },
        paused: { ...runtime.value.paused, personal: false },
        personalPauseReason: null,
      }
    }
    // 按当前对局状态恢复尚未完成的决策（已落地的兜底动作不重放）
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

  async function startRequest(state: GameState, actor: AiActorId, candidates: Candidate[], credential: JevCredential) {
    const decisionId = crypto.randomUUID()
    const requestGeneration = generation
    inFlight.value = {
      decisionId,
      gameId: state.gameId,
      revision: state.revision,
      actorId: actor,
      phaseKind: state.phase.kind as InFlightDecision['phaseKind'],
      credentialSource: credential.source,
    }
    const controller = new AbortController()
    abortController = controller
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? BROWSER_DECISION_TIMEOUT_MS)

    const request: AiDecisionRequest = {
      protocolVersion: AI_PROTOCOL_VERSION,
      rulesVersion: AI_RULES_VERSION,
      credentialSource: credential.source,
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
        headers: {
          'Content-Type': 'application/json',
          // 个人 Key 只经同源 HTTPS 请求的专用请求头传递，不进入请求体
          ...(credential.source === 'personal' && credential.personalKey !== null
            ? { [AI_PERSONAL_KEY_HEADER]: credential.personalKey }
            : {}),
        },
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
        handleFailure(response.status, response.headers.get('retry-after'), body, actor, credential)
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

  /** 按发起请求时使用的凭据来源归属暂停与冷却。 */
  function handleFailure(status: number, retryAfterHeader: string | null, body: AiErrorResponse | null, actor: AiActorId, credential: JevCredential) {
    const code = body?.error?.code
    const source = credential.source
    if (code === 'ai_site_quota_exhausted') {
      // 站点额度确认耗尽：会话内粘滞，仅影响站点来源；当前对局保留，规则兜底继续
      siteQuotaExhausted.value = true
      runFallback(actor, 'site_quota_exhausted')
      return
    }
    if (status === 429 || code === 'ai_rate_limited') {
      // 429 = 调用方限流：按来源冷却，至少 30 秒；更长的有效 Retry-After 优先
      const retrySeconds = Number.parseInt(retryAfterHeader ?? '', 10)
      const cooldownMs = Number.isSafeInteger(retrySeconds) && retrySeconds > 0
        ? Math.max(RATE_LIMIT_COOLDOWN_MS, retrySeconds * 1000)
        : RATE_LIMIT_COOLDOWN_MS
      runtime.value = { ...runtime.value, cooldownUntil: { ...runtime.value.cooldownUntil, [source]: Date.now() + cooldownMs } }
      runFallback(actor, 'rate_limited')
      return
    }
    if (code === 'ai_overloaded') {
      // 529 = 服务方过载：非额度耗尽、非调用方限流；仅在给出 Retry-After 时冷却
      const retrySeconds = Number.parseInt(retryAfterHeader ?? '', 10)
      if (Number.isSafeInteger(retrySeconds) && retrySeconds > 0) {
        runtime.value = { ...runtime.value, cooldownUntil: { ...runtime.value.cooldownUntil, [source]: Date.now() + retrySeconds * 1000 } }
      }
      runFallback(actor, 'service_overloaded')
      return
    }
    if (code === 'ai_key_rejected' && source === 'personal') {
      // 上游拒绝用户自己的 Key（无效或无权限）：归属个人 Key，暂停个人来源
      runtime.value = {
        ...runtime.value,
        paused: { ...runtime.value.paused, personal: true },
        personalPauseReason: 'key_rejected',
      }
      runFallback(actor, 'personal_key_rejected')
      return
    }
    if (status === 503 || code === 'ai_unavailable') {
      // 缺 key / 模型配置或站点密钥被拒：按来源暂停，本页面会话内不再自动重试
      runtime.value = {
        ...runtime.value,
        paused: { ...runtime.value.paused, [source]: true },
        personalPauseReason: source === 'personal' ? 'unavailable' : runtime.value.personalPauseReason,
      }
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
      || data.protocolVersion !== AI_PROTOCOL_VERSION
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
      // 只有 1 个候选时直接执行并记为 forced，不调用 Jev（与凭据无关）
      deps.submitAction(actor, candidates[0]!.action, { aiSource: 'forced' })
      return
    }
    const credential = deps.getCredential()
    lastCredential = { ...credential }
    if (credential.source === 'personal' && credential.personalKey === null) {
      // 个人模式缺少 Key：不得悄悄改用站点额度，明确标记兜底原因
      runFallback(actor, 'personal_key_missing')
      return
    }
    if (credential.source === 'site' && siteQuotaExhausted.value) {
      // 站点额度确认耗尽（粘滞）：不再发请求，规则兜底继续，保留来源标识
      runFallback(actor, 'site_quota_exhausted')
      return
    }
    if (runtime.value.paused[credential.source]) {
      const reason: FallbackReason = credential.source === 'personal'
        ? (runtime.value.personalPauseReason === 'key_rejected' ? 'personal_key_rejected' : 'ai_unavailable')
        : 'ai_unavailable'
      runFallback(actor, reason)
      return
    }
    if (runtime.value.cooldownUntil[credential.source] > Date.now()) {
      runFallback(actor, 'rate_limited')
      return
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      // 离线期间直接兜底；恢复网络后的新决策再尝试
      runFallback(actor, 'offline')
      return
    }
    void startRequest(state, actor, candidates, credential)
  }

  onBeforeUnmount(() => {
    cancelAll()
  })

  return {
    inFlight,
    cooldownUntil,
    jevPaused,
    personalPauseReason: readonly(computed(() => runtime.value.personalPauseReason)),
    siteQuotaExhausted: readonly(siteQuotaExhausted),
    schedule,
    cancelAll,
    resumeJev,
    onCredentialsChanged,
  }
}
