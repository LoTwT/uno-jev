import type { Card, Color, DecisionSource, FallbackReason, PublicEvent } from '#shared/game'
/**
 * 中文显示辅助：牌面标签、事件描述与决策来源文案。
 * 仅供 UI 展示；规则与 AI 协议使用各自的英文 / 结构化描述。
 */
import { getCard } from '#shared/game'

export const COLOR_NAMES: Record<Color, string> = {
  red: '红',
  yellow: '黄',
  green: '绿',
  blue: '蓝',
}

export function colorName(color: Color | null | undefined): string {
  return color ? COLOR_NAMES[color] : '未定'
}

/** 牌面短标签：红 5 / 红 跳过 / 万能 / 万能 +4。 */
export function cardLabel(card: Card): string {
  switch (card.kind) {
    case 'number':
      return `${COLOR_NAMES[card.color!]} ${card.value}`
    case 'skip':
      return `${COLOR_NAMES[card.color!]} 跳过`
    case 'reverse':
      return `${COLOR_NAMES[card.color!]} 反转`
    case 'draw-two':
      return `${COLOR_NAMES[card.color!]} +2`
    case 'wild':
      return '万能'
    case 'wild-draw-four':
      return '万能 +4'
  }
}

/** 牌面中央符号。 */
export function cardSymbol(card: Card): string {
  switch (card.kind) {
    case 'number':
      return String(card.value)
    case 'skip':
      return '⊘'
    case 'reverse':
      return '⇄'
    case 'draw-two':
      return '+2'
    case 'wild':
      return '★'
    case 'wild-draw-four':
      return '+4'
  }
}

export function playerNameOf(players: Array<{ id: string, name: string }>, id: string): string {
  return players.find(player => player.id === id)?.name ?? id
}

export function sourceBadgeText(source: DecisionSource): string {
  switch (source) {
    case 'jev':
      return 'Jev 决策'
    case 'forced':
      return '按规则执行'
    case 'fallback':
      return '规则策略'
  }
}

export function fallbackReasonText(reason: FallbackReason): string {
  switch (reason) {
    case 'invalid_request':
      return '请求不符合合同'
    case 'rate_limited':
      return '限流冷却'
    case 'ai_unavailable':
      return 'AI 暂不可用'
    case 'invalid_response':
      return '响应无效'
    case 'upstream_error':
      return '上游错误'
    case 'timeout':
      return '超时'
    case 'network_error':
      return '网络错误'
    case 'offline':
      return '离线'
  }
}

/** 公开事件的中文描述（回合播报与日志共用）。 */
export function eventDescription(event: PublicEvent, players: Array<{ id: string, name: string }>): string {
  const name = (id: string) => playerNameOf(players, id)
  switch (event.type) {
    case 'game-started':
      return `新局开始，庄家是 ${name(event.dealerId)}，起始牌 ${cardLabel(cardOf(event.openingCardId))}`
    case 'opening-color-chosen':
      return `${name(event.playerId)} 选定起始颜色：${COLOR_NAMES[event.color]}`
    case 'card-played':
      return `${name(event.playerId)} 打出 ${cardLabel(cardOf(event.cardId))}${event.chosenColor ? `，选 ${COLOR_NAMES[event.chosenColor]} 色` : ''}`
    case 'direction-reversed':
      return `${name(event.byPlayerId)} 打出反转，方向掉头`
    case 'uno-declared':
      return `${name(event.playerId)} 宣告 UNO`
    case 'uno-miss-caught':
      return `${name(event.caughtBy)} 抓到 ${name(event.playerId)} 漏喊 UNO，罚抽 ${event.penaltyCount} 张`
    case 'cards-drawn':
      if (event.requested === event.drawn) {
        const reason = event.reason === 'turn' ? '' : '（罚抽）'
        return `${name(event.playerId)} 抽了 ${event.drawn} 张${reason}`
      }
      return `${name(event.playerId)} 应抽 ${event.requested} 张，实际只抽到 ${event.drawn} 张`
    case 'player-skipped':
      return `${name(event.playerId)} 被跳过`
    case 'pile-reshuffled':
      return `弃牌堆重洗，回收 ${event.recycledCount} 张`
    case 'kept-drawn':
      return `${name(event.playerId)} 保留抽到的牌，结束回合`
    case 'decision-source': {
      const source = sourceBadgeText(event.source)
      const reason = event.reason ? `（${fallbackReasonText(event.reason)}）` : ''
      return `${name(event.playerId)} 本次行动：${source}${reason}`
    }
    case 'game-finished':
      if (event.result.reason === 'empty-hand') {
        return `${name(event.result.winnerId)} 出完手牌获胜`
      }
      return '连续多个回合无牌可抽，本局为和局'
  }
}

function cardOf(cardId: string): Card {
  const card = getCard(cardId)
  if (!card) {
    throw new Error(`未知牌 ID: ${cardId}`)
  }
  return card
}
