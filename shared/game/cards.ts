/**
 * 固定牌组目录：108 张经典基础牌与稳定 CardId。
 *
 * 同一面值的两张牌使用 -1 / -2 后缀区分实例；
 * ID 不编码洗牌后的顺序，全部 ID 由本目录单一定义。
 */
import type { Card, CardId, Color, PlayerId, PlayerType } from './types'
import { COLORS, PLAYER_IDS } from './types'

/** 默认座位显示名称：真人 + 三个 Jev AI。 */
export const DEFAULT_PLAYER_NAMES: Record<PlayerId, string> = {
  p0: '你',
  p1: 'Jev 1',
  p2: 'Jev 2',
  p3: 'Jev 3',
}

export const DEFAULT_PLAYER_TYPES: Record<PlayerId, PlayerType> = {
  p0: 'human',
  p1: 'jev',
  p2: 'jev',
  p3: 'jev',
}

function buildDeck(): Card[] {
  const cards: Card[] = []
  for (const color of COLORS) {
    // 每种颜色：1 张 0，各 2 张 1..9
    cards.push({ id: `${color}-0-1`, kind: 'number', color, value: 0 })
    for (let value = 1; value <= 9; value++) {
      for (const copy of [1, 2] as const) {
        cards.push({ id: `${color}-${value}-${copy}`, kind: 'number', color, value })
      }
    }
    // 每种颜色：各 2 张 Skip、Reverse、Draw Two
    for (const kind of ['skip', 'reverse', 'draw-two'] as const) {
      for (const copy of [1, 2] as const) {
        cards.push({ id: `${color}-${kind}-${copy}`, kind, color, value: null })
      }
    }
  }
  // 4 张 Wild 与 4 张 Wild Draw Four
  for (let copy = 1; copy <= 4; copy++) {
    cards.push({ id: `wild-${copy}`, kind: 'wild', color: null, value: null })
    cards.push({ id: `wild-draw-four-${copy}`, kind: 'wild-draw-four', color: null, value: null })
  }
  return cards
}

/** 牌组目录；顺序稳定，任何代码不得依赖此顺序表达牌局位置。 */
export const DECK: readonly Card[] = buildDeck()

export const DECK_SIZE = DECK.length

const cardById = new Map<CardId, Card>(DECK.map(card => [card.id, card]))

/** 按 ID 查牌；未命中目录返回 null。 */
export function getCard(id: CardId): Card | null {
  return cardById.get(id) ?? null
}

export function isCardId(id: string): id is CardId {
  return cardById.has(id)
}

/** Wild 类（无固有颜色）。 */
export function isWildKind(kind: Card['kind']): boolean {
  return kind === 'wild' || kind === 'wild-draw-four'
}

export function isColor(value: unknown): value is Color {
  return typeof value === 'string' && (COLORS as readonly string[]).includes(value)
}

export function isPlayerId(value: unknown): value is PlayerId {
  return typeof value === 'string' && (PLAYER_IDS as readonly string[]).includes(value)
}

/** 英文牌名，用于 AI 候选描述（中文显示名在 app 层维护）。 */
export function cardNameEn(card: Card): string {
  const colorName = card.color ? card.color[0]!.toUpperCase() + card.color.slice(1) : ''
  switch (card.kind) {
    case 'number':
      return `${colorName} ${card.value}`
    case 'skip':
      return `${colorName} Skip`
    case 'reverse':
      return `${colorName} Reverse`
    case 'draw-two':
      return `${colorName} Draw Two`
    case 'wild':
      return 'Wild'
    case 'wild-draw-four':
      return 'Wild Draw Four'
  }
}
