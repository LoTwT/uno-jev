import { AI_REQUEST_BODY_LIMIT_BYTES } from '#shared/ai/protocol'
/**
 * POST /api/ai/decision：同源 AI 决策代理。
 *
 * 路由只做 HTTP 适配（读取头与原始体、体积前置检查、回写状态），
 * 全部校验与上游调用逻辑在 server/utils/aiDecision.ts 中独立测试。
 */
import { handleAiDecision } from '../../utils/aiDecision'

export default defineEventHandler(async (event) => {
  const runtimeConfig = useRuntimeConfig(event)

  // 体积前置检查：Content-Length 超限时不必读取请求体
  const contentLengthHeader = getRequestHeader(event, 'content-length')
  const declaredLength = contentLengthHeader !== undefined ? Number.parseInt(contentLengthHeader, 10) : Number.NaN
  if (Number.isSafeInteger(declaredLength) && declaredLength > AI_REQUEST_BODY_LIMIT_BYTES) {
    setResponseStatus(event, 400)
    setResponseHeader(event, 'Cache-Control', 'no-store')
    return { error: { code: 'invalid_request' as const } }
  }

  const bodyText = await readRawBody(event, 'utf8') ?? ''
  const result = await handleAiDecision({
    origin: getRequestHeader(event, 'origin') ?? null,
    host: getRequestHeader(event, 'host') ?? null,
    contentType: getRequestHeader(event, 'content-type') ?? null,
    contentLength: contentLengthHeader ?? null,
    bodyText,
    runtimeConfig: {
      typesafeApiKey: String(runtimeConfig.typesafeApiKey ?? ''),
      typesafeModel: String(runtimeConfig.typesafeModel ?? ''),
    },
  })

  for (const [key, value] of Object.entries(result.headers)) {
    setResponseHeader(event, key, value)
  }
  setResponseStatus(event, result.status)
  return result.body
})
