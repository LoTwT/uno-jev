<script setup lang="ts">
/**
 * 规则说明对话框：明确显示单局、无叠加、严格 +4、AI 自动抓漏，
 * 以及"系统校验 +4，本版不提供质疑"，不暗示完整实现官方质疑流程。
 */
const open = defineModel<boolean>({ default: false })
</script>

<template>
  <Teleport to="body">
    <Transition name="game-fade">
      <div
        v-if="open"
        class="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-4"
        role="dialog"
        aria-modal="true"
        aria-label="规则说明"
        @click.self="open = false"
      >
        <div class="w-full sm:max-w-lg max-h-[80dvh] overflow-y-auto rounded-2xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5 shadow-lg">
          <div class="flex items-center justify-between mb-3">
            <h2 class="text-lg font-bold">
              规则说明
            </h2>
            <button
              type="button"
              class="min-h-11 min-w-11 px-3 rounded-lg border border-[var(--border-default)] hover:bg-[var(--surface-subtle)]"
              aria-label="关闭规则说明"
              @click="open = false"
            >
              ✕
            </button>
          </div>
          <div class="text-sm space-y-3 leading-relaxed">
            <p>
              经典 UNO 基础玩法，108 张牌，4 个座位（你对阵 Jev 1 / Jev 2 / Jev 3）。
              <strong>单局胜负</strong>：先出完手牌者获胜，不累计 500 分。
            </p>
            <ul class="list-disc list-inside space-y-1">
              <li>每回合出 1 张牌：匹配当前颜色，或匹配顶牌数字 / 功能符号；万能牌可随时出。</li>
              <li>可以不出牌改为抽 1 张；抽到可出的牌可以立即出这张，或保留并结束回合。</li>
              <li>跳过：下一位被跳过。反转：方向掉头（四人局不当跳过用）。</li>
              <li><strong>+2 / +4 不叠加</strong>：受罚者抽牌并被跳过，没有接牌机会。</li>
              <li>
                <strong>严格 +4</strong>：系统自动校验——手中还有与当前颜色相同的牌时不能出 +4。
                因此本版<strong>不提供质疑</strong>，也没有虚张声势动作。
              </li>
              <li>
                <strong>UNO 宣告</strong>：出到剩 1 张牌时用"UNO 并出牌"宣告。
                忘记宣告会被 AI 抓到并罚抽 2 张；AI 总会宣告，也总会在回合转交前抓到你的漏喊。
              </li>
              <li>抽牌堆耗尽时，保留弃牌堆顶牌，其余洗回抽牌堆继续。</li>
            </ul>
            <p class="text-[var(--text-muted)]">
              Jev 负责在合法动作中选择；网络不可用或超时时按明确标识的规则策略继续。
              对战强度尚未实测验证。
            </p>
          </div>
          <button
            type="button"
            class="mt-4 w-full min-h-11 rounded-lg bg-[var(--accent-primary)] text-[var(--accent-contrast)] font-semibold hover:bg-[var(--accent-primary-hover)]"
            @click="open = false"
          >
            知道了
          </button>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
