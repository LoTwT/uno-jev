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
/** 新局确认对话框中的动态提示（存档变化 / 未确认对局）。 */
const confirmNotice = ref<string | null>(null)

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
/** 选中的牌是否属于 Wild 类（需要选色）。 */
const needsColor = computed(() => {
  const card = selectedCardView.value?.card
  return card ? (card.kind === 'wild' || card.kind === 'wild-draw-four') : false
})
/** 当前是否尚未选色：Wild 类已选中且草稿颜色未定（选色后即可出牌）。 */
const colorPending = computed(() => needsColor.value && wildColorDraft.value === null)
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

/** 已知存在需要确认的进行中对局（内存或入口存档）。 */
function hasKnownInProgressGame(): boolean {
  if (session.status.value === 'playing' && state.value && phaseKind.value !== 'finished') {
    return true
  }
  const load = session.entrySave.value
  return load.status === 'valid' && !!load.envelope && load.envelope.state.phase.kind !== 'finished'
}

async function onStartNewGame() {
  confirmNotice.value = null
  // 替换进行中的唯一槽位前由产品界面确认
  if (hasKnownInProgressGame()) {
    confirmNewGame.value = true
    return
  }
  // 会话层在取得锁后会重新读取最新槽位；若发现未确认的进行中对局（可能来自其他标签页），
  // 返回 needs-confirmation 并要求用户按最新进度重新确认，不静默覆盖
  const result = await session.startNewGame()
  if (result === 'needs-confirmation') {
    confirmNotice.value = '检测到尚未确认的对局存档（可能来自其他标签页），请确认后覆盖。'
    confirmNewGame.value = true
  }
}

async function confirmStartNewGame() {
  // 用户在对话框中确认的是当前展示的版本；写入前会话层会再次核对槽位签名
  const signature = session.currentSlotSignature()
  confirmNewGame.value = false
  const result = await session.startNewGame(signature)
  if (result === 'needs-confirmation') {
    confirmNotice.value = '存档在确认后发生了变化，请按最新进度重新确认。'
    confirmNewGame.value = true
  }
}

function cancelNewGameConfirm() {
  confirmNewGame.value = false
  confirmNotice.value = null
}

async function onRestartGame() {
  confirmNotice.value = null
  const result = await session.startNewGame()
  if (result === 'needs-confirmation') {
    confirmNotice.value = '检测到尚未确认的对局存档（可能来自其他标签页），请确认后覆盖。'
    confirmNewGame.value = true
  }
}

/** 确认对话框展示的"将被覆盖的存档"摘要（取锁后刷新过的最新信息）。 */
const overwriteSummary = computed(() => {
  if (session.status.value === 'playing' && state.value && phaseKind.value !== 'finished') {
    return `本页进行中的对局（第 ${state.value.revision} 步，手牌 ${session.humanPlayer.value?.hand.length ?? 0} 张）`
  }
  const load = session.entrySave.value
  if (load.status === 'invalid') {
    return '无法读取的存档'
  }
  if (load.status === 'valid' && load.envelope) {
    const saved = load.envelope.state
    if (saved.phase.kind === 'finished') {
      return null
    }
    return `已保存的对局（第 ${saved.revision} 步，你的手牌 ${saved.players[0]?.hand.length ?? 0} 张）`
  }
  return null
})

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
          :storage-unavailable="!session.storageAvailable.value"
          @start="onStartNewGame"
          @continue="session.continueGame()"
          @start-temp="session.startTempGame()"
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
            <template v-if="state">
              本页还有未保存的进度（第 {{ state.revision }} 步），也可以保留它仅在此页继续。
            </template>
          </p>
          <div class="flex gap-2 flex-wrap">
            <button
              type="button"
              class="min-h-11 px-5 rounded-lg bg-[var(--accent-primary)] text-[var(--accent-contrast)] font-semibold hover:bg-[var(--accent-primary-hover)]"
              @click="session.reloadFromSlot()"
            >
              重新加载最新存档
            </button>
            <button
              v-if="state"
              type="button"
              class="min-h-11 px-5 rounded-lg border-2 border-[var(--border-strong)] font-semibold hover:bg-[var(--surface-subtle)]"
              @click="session.continueInMemoryOnly()"
            >
              保留本页进度，仅在此页继续
            </button>
          </div>
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

          <!-- Jev 暂停：明确状态与重试入口（只恢复后续决策） -->
          <div v-if="session.aiTurn.jevPaused.value" class="flex justify-center">
            <AiPauseNotice @retry="session.aiTurn.resumeJev()" />
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
            @restart="onRestartGame()"
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
              :color-pending="colorPending"
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
          @click.self="cancelNewGameConfirm"
        >
          <div class="w-full max-w-sm rounded-2xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5">
            <h2 class="font-bold mb-2">
              新开一局将替换当前存档
            </h2>
            <p class="text-sm text-[var(--text-secondary)] mb-2">
              浏览器只保留一个对局槽位。开始新局后，现有对局进度将被覆盖，此操作不可撤销。
            </p>
            <p
              v-if="confirmNotice"
              class="text-sm rounded-lg border border-[var(--status-warning-border)] bg-[var(--status-warning-bg)] text-[var(--status-warning-fg)] p-2 mb-2"
              role="alert"
            >
              {{ confirmNotice }}
            </p>
            <p v-if="overwriteSummary" class="text-xs text-[var(--text-muted)] mb-3">
              当前存档：{{ overwriteSummary }}
            </p>
            <div class="flex gap-2 justify-end">
              <button
                type="button"
                class="min-h-11 px-4 rounded-lg border-2 border-[var(--border-strong)] font-medium hover:bg-[var(--surface-subtle)]"
                @click="cancelNewGameConfirm"
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
