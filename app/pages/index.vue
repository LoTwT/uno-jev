<script setup lang="ts">
/**
 * 唯一页面：入口、对局、只读、存档异常与冲突的会话视图。
 * SSR 只输出外壳；对局数据在客户端初始化之后才恢复。
 */
import type { Card, Color } from '#shared/game'
import { usePreferences } from '~/composables/usePreferences'
import { useUnoGame } from '~/composables/useUnoGame'
import { cardLabel, eventDescription } from '~/utils/display'

const session = useUnoGame()
const { themeIntent, setTheme, reducedMotion, setReducedMotion } = usePreferences()

const rulesOpen = ref(false)
const confirmNewGame = ref(false)

// ---- 真人选牌草稿（选色前不移牌；刷新放弃草稿） ----
const selectedCardId = ref<string | null>(null)
const wildColorDraft = ref<Color | null>(null)

const state = computed(() => session.state.value)
const phaseKind = computed(() => session.phaseKind.value)
const isHumanTurn = computed(() => session.isHumanTurn.value)

const selectedCardView = computed(() =>
  session.handCards.value.find(card => card.card.id === selectedCardId.value) ?? null,
)
const drawnCardView = computed(() =>
  session.handCards.value.find(card => card.isDrawn) ?? null,
)
const needsColor = computed(() => {
  const card = selectedCardView.value?.card
  return card ? (card.kind === 'wild' || card.kind === 'wild-draw-four') : false
})
const canDeclareUno = computed(() =>
  session.humanPlayer.value?.hand.length === 2 && selectedCardView.value !== null,
)
const humanIsChoosingOpening = computed(() =>
  isHumanTurn.value && phaseKind.value === 'opening-color',
)
const humanAfterDraw = computed(() =>
  isHumanTurn.value && phaseKind.value === 'after-draw' && session.drawnCardId.value !== null,
)

// 状态推进后清除草稿；抽到可出的牌时自动选中，方便立即"出 / 留"
watch(() => state.value?.revision, () => {
  selectedCardId.value = session.drawnCardId.value
  wildColorDraft.value = null
})
watch(isHumanTurn, (now, before) => {
  if (!now && before) {
    selectedCardId.value = null
    wildColorDraft.value = null
  }
})

function onSelectCard(card: Card) {
  if (!isHumanTurn.value) {
    return
  }
  if (phaseKind.value === 'after-draw' && card.id !== session.drawnCardId.value) {
    return
  }
  selectedCardId.value = selectedCardId.value === card.id ? null : card.id
  wildColorDraft.value = null
}

function onPlay(payload: { declareUno: boolean }) {
  const card = selectedCardView.value
  if (!card || !card.playable) {
    return
  }
  if (needsColor.value && wildColorDraft.value === null) {
    return
  }
  session.playCard(card.card.id, needsColor.value ? wildColorDraft.value! : undefined, payload.declareUno)
}

function onDraw() {
  session.drawOne()
}

function onKeepDrawn() {
  session.keepDrawn()
}

function onOpeningColor(color: Color) {
  session.chooseOpeningColor(color)
}

function onWildColorDraft(color: Color) {
  wildColorDraft.value = color
}

function cancelWildDraft() {
  wildColorDraft.value = null
  selectedCardId.value = null
}

// ---- 回合提示与播报 ----
const turnHint = computed(() => {
  const game = state.value
  if (!game || phaseKind.value === 'finished') {
    return '对局已结束'
  }
  if (game.currentPlayerId === 'p0') {
    if (phaseKind.value === 'opening-color') {
      return '起始牌是万能牌，请选择开局颜色'
    }
    if (phaseKind.value === 'after-draw') {
      const drawn = drawnCardView.value
      return drawn ? `你抽到一张可出的牌（${cardLabel(drawn.card)}），可以出这张或保留并结束` : '你抽到一张可出的牌'
    }
    return '轮到你了：选择一张牌打出，或抽 1 张'
  }
  const name = game.players.find(p => p.id === game.currentPlayerId)?.name ?? game.currentPlayerId
  return `${name} 正在思考…`
})

const liveAnnouncement = computed(() => {
  const game = state.value
  if (!game) {
    return ''
  }
  if (phaseKind.value === 'finished') {
    return eventDescription(game.recentEvents[game.recentEvents.length - 1]!, game.players)
  }
  const name = game.players.find(p => p.id === game.currentPlayerId)?.name ?? ''
  return game.currentPlayerId === 'p0' ? '轮到你了' : `轮到 ${name}`
})

const thinkingActorId = computed(() => session.aiTurn.inFlight.value?.actorId ?? null)

function onStartNewGame() {
  const game = state.value
  // 替换进行中的唯一槽位前由产品界面确认
  if (session.status.value === 'playing' && game && phaseKind.value !== 'finished') {
    confirmNewGame.value = true
    return
  }
  // 入口处已有未结束存档时同样确认
  if (session.entrySave.value.status === 'valid' && session.entrySave.value.envelope && session.entrySave.value.envelope.state.phase.kind !== 'finished') {
    confirmNewGame.value = true
    return
  }
  session.startNewGame()
}

function confirmStartNewGame() {
  confirmNewGame.value = false
  session.startNewGame()
}

useHead({ title: 'UnoJev — 与 Jev 一起玩 UNO' })
</script>

<template>
  <div class="min-h-dvh flex flex-col">
    <!-- 顶栏：标题、主题与规则入口（设置不受游戏锁限制） -->
    <header class="flex items-center justify-between gap-3 px-4 py-3 border-b border-[var(--border-subtle)]">
      <div class="flex items-center gap-2 min-w-0">
        <h1 class="font-bold text-lg whitespace-nowrap">
          UnoJev
        </h1>
        <span class="text-xs text-[var(--text-muted)] hidden sm:inline">单机 · 三位 Jev AI · 本地存档</span>
      </div>
      <div class="flex items-center gap-2">
        <label class="sr-only" for="reduced-motion-toggle">减少动态</label>
        <button
          id="reduced-motion-toggle"
          type="button"
          class="min-h-11 px-2 rounded-lg border border-[var(--border-default)] text-xs whitespace-nowrap"
          :aria-pressed="reducedMotion"
          title="减少动态效果（关闭位移动画）"
          @click="setReducedMotion(reducedMotion ? 'system' : 'reduce')"
        >
          {{ reducedMotion ? '动态：已减少' : '动态：跟随系统' }}
        </button>
        <ThemeToggle :intent="themeIntent" @set="setTheme" />
        <button
          type="button"
          class="min-h-11 px-3 rounded-lg border border-[var(--border-default)] text-sm hover:bg-[var(--surface-subtle)]"
          @click="rulesOpen = true"
        >
          规则
        </button>
      </div>
    </header>

    <!-- 回合播报（无障碍） -->
    <p class="sr-only" role="status" aria-live="polite">
      {{ liveAnnouncement }}
    </p>

    <main class="flex-1 flex items-start sm:items-center justify-center p-3 sm:p-6">
      <ClientOnly>
        <!-- 初始化骨架 -->
        <template #fallback>
          <div class="text-sm text-[var(--text-muted)]" aria-label="加载中">
            正在加载 UnoJev…
          </div>
        </template>

        <!-- 启动中 -->
        <div v-if="session.status.value === 'boot'" class="text-sm text-[var(--text-muted)]">
          正在准备…
        </div>

        <!-- 入口 -->
        <EntryScreen
          v-else-if="session.status.value === 'entry'"
          :has-valid-save="session.entrySave.value.status === 'valid'"
          :saved-state="session.entrySave.value.status === 'valid' ? session.entrySave.value.envelope?.state ?? null : null"
          @start="onStartNewGame"
          @continue="session.continueGame()"
          @show-rules="rulesOpen = true"
        />

        <!-- 存档无法读取 -->
        <div v-else-if="session.status.value === 'invalid-save'" class="max-w-md w-full rounded-xl border border-[var(--status-warning-border)] bg-[var(--status-warning-bg)] p-5">
          <h2 class="font-bold text-[var(--status-warning-fg)] mb-2">
            存档无法读取
          </h2>
          <p class="text-sm text-[var(--text-secondary)] mb-1">
            {{ session.entrySave.value.message ?? '本地存档校验未通过。' }}
          </p>
          <p class="text-xs text-[var(--text-muted)] mb-4">
            原始存档已保留，不会被自动重置。你可以清除它并新开一局。
          </p>
          <button
            type="button"
            class="min-h-11 px-5 rounded-lg bg-[var(--accent-primary)] text-[var(--accent-contrast)] font-semibold hover:bg-[var(--accent-primary-hover)]"
            @click="session.clearInvalidSaveAndStart()"
          >
            清除并新开一局
          </button>
        </div>

        <!-- 槽位冲突 / 外部修改 -->
        <div v-else-if="session.status.value === 'slot-conflict'" class="max-w-md w-full rounded-xl border border-[var(--status-warning-border)] bg-[var(--status-warning-bg)] p-5">
          <h2 class="font-bold text-[var(--status-warning-fg)] mb-2">
            存档被其他页面修改
          </h2>
          <p class="text-sm text-[var(--text-secondary)] mb-4">
            检测到本地存档与本页状态不一致（{{ session.slotProblemKind.value === 'missing' ? '槽位被删除' : '内容被外部改写' }}）。
            本页已停止写入并取消未完成的 AI 请求；请重新加载最新存档。
          </p>
          <button
            type="button"
            class="min-h-11 px-5 rounded-lg bg-[var(--accent-primary)] text-[var(--accent-contrast)] font-semibold hover:bg-[var(--accent-primary-hover)]"
            @click="session.reloadFromSlot()"
          >
            重新加载最新存档
          </button>
        </div>

        <!-- 只读视图 -->
        <ReadOnlyNotice
          v-else-if="session.status.value === 'readonly-locked' || session.status.value === 'no-lock-browser'"
          :mode="session.status.value === 'readonly-locked' ? 'locked' : 'no-lock'"
          :state="session.entrySave.value.status === 'valid' ? session.entrySave.value.envelope?.state ?? null : null"
          :invalid-message="session.entrySave.value.status === 'invalid' ? (session.entrySave.value.message ?? '存档无法读取') : null"
          @take-control="session.tryTakeControl()"
          @start-temp="session.startTempGame()"
        />

        <!-- 对局进行中 / 已结束 -->
        <div v-else-if="session.status.value === 'playing' && state" class="w-full max-w-4xl flex flex-col gap-3">
          <!-- 保存状态（失败时显著提示） -->
          <div v-if="session.persistence.saveHealth.value !== 'ok'" class="flex justify-center">
            <SaveStatusBar
              :health="session.persistence.saveHealth.value"
              @retry="session.retrySave()"
              @continue-in-memory="session.continueInMemoryOnly()"
            />
          </div>

          <!-- 对手区 -->
          <div class="grid grid-cols-3 gap-2">
            <OpponentPanel
              v-for="opponent in session.opponents.value"
              :key="opponent.player.id"
              :opponent="opponent"
              :is-current="state.currentPlayerId === opponent.player.id && phaseKind !== 'finished'"
              :thinking="thinkingActorId === opponent.player.id"
            />
          </div>

          <!-- 牌桌中心 -->
          <TableCenter
            :top-card="session.topCard.value"
            :current-color="state.currentColor"
            :direction="state.direction"
            :draw-pile-count="state.drawPile.length"
          />

          <!-- 结束页覆盖中心操作区 -->
          <FinishedOverlay
            v-if="phaseKind === 'finished'"
            :state="state"
            @restart="session.startNewGame()"
            @exit="session.exitToEntry()"
          />

          <template v-else>
            <!-- 开局选色（真人） -->
            <div v-if="humanIsChoosingOpening" class="max-w-md w-full mx-auto">
              <ColorPicker purpose="opening" @choose="onOpeningColor" />
            </div>

            <!-- Wild 选色草稿 -->
            <div v-else-if="needsColor && isHumanTurn" class="max-w-md w-full mx-auto">
              <ColorPicker
                purpose="play-wild"
                @choose="onWildColorDraft"
                @cancel="cancelWildDraft"
              />
              <p v-if="wildColorDraft" class="text-xs text-[var(--text-secondary)] mt-1 text-center">
                已选 {{ wildColorDraft === 'red' ? '红' : wildColorDraft === 'yellow' ? '黄' : wildColorDraft === 'green' ? '绿' : '蓝' }} 色，点击"出牌"确认（选色前不移牌）
              </p>
            </div>

            <!-- 真人手牌 -->
            <PlayerHand
              :cards="session.handCards.value"
              :active="isHumanTurn"
              :selected-id="selectedCardId"
              @select="onSelectCard"
            />

            <!-- 回合操作 -->
            <TurnActions
              :active="isHumanTurn"
              :selected-card="selectedCardView?.card ?? null"
              :can-declare-uno="canDeclareUno"
              :needs-color="needsColor"
              :after-draw="humanAfterDraw"
              :drawn-card="drawnCardView?.card ?? null"
              :phase-hint="turnHint"
              @play="onPlay"
              @draw="onDraw"
              @keep-drawn="onKeepDrawn"
            />

            <!-- 动作错误提示 -->
            <p
              v-if="session.actionError.value"
              class="text-sm text-[var(--status-danger-fg)] text-center"
              role="alert"
            >
              {{ session.actionError.value }}
              <button type="button" class="underline ml-2" @click="session.dismissActionError()">
                知道了
              </button>
            </p>
          </template>

          <!-- 日志与返回入口 -->
          <div class="flex flex-col sm:flex-row gap-3 items-start">
            <div class="w-full sm:flex-1 min-w-0">
              <GameLog :events="session.recentEvents.value" :players="state.players" />
            </div>
            <div class="flex flex-col gap-2 shrink-0">
              <button
                v-if="phaseKind !== 'finished'"
                type="button"
                class="min-h-11 px-4 rounded-lg border border-[var(--border-default)] text-sm text-[var(--text-secondary)] hover:bg-[var(--surface-subtle)]"
                @click="session.exitToEntry()"
              >
                放弃并返回入口
              </button>
            </div>
          </div>
        </div>
      </ClientOnly>
    </main>

    <footer class="px-4 py-3 pb-[calc(env(safe-area-inset-bottom,0px)+0.75rem)] text-xs text-[var(--text-muted)] border-t border-[var(--border-subtle)] flex justify-between gap-2 whitespace-nowrap">
      <span>对局数据仅保存在本浏览器</span>
      <span>Jev 决策经同源服务代理</span>
    </footer>

    <!-- 规则说明 -->
    <RulesDialog v-model="rulesOpen" />

    <!-- 新局确认 -->
    <Teleport to="body">
      <Transition name="game-fade">
        <div
          v-if="confirmNewGame"
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="确认新开一局"
          @click.self="confirmNewGame = false"
        >
          <div class="w-full max-w-sm rounded-2xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5">
            <h2 class="font-bold mb-2">
              新开一局将替换当前存档
            </h2>
            <p class="text-sm text-[var(--text-secondary)] mb-4">
              浏览器只保留一个对局槽位。开始新局后，现有对局进度将被覆盖，此操作不可撤销。
            </p>
            <div class="flex gap-2 justify-end">
              <button
                type="button"
                class="min-h-11 px-4 rounded-lg border-2 border-[var(--border-strong)] font-medium hover:bg-[var(--surface-subtle)]"
                @click="confirmNewGame = false"
              >
                取消
              </button>
              <button
                type="button"
                class="min-h-11 px-4 rounded-lg bg-[var(--accent-primary)] text-[var(--accent-contrast)] font-semibold hover:bg-[var(--accent-primary-hover)]"
                @click="confirmStartNewGame"
              >
                新开一局
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>
