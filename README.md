# UnoJev

UnoJev 是 1 位真人与 3 位 Jev AI 对手的单人 UNO 游戏。经典 108 张基础牌、单局胜负，默认中文界面，面向桌面和手机。对局完整保存在浏览器本地；服务端只代理受限的 Jev 决策请求。

- [v1 产品与技术规格](docs/specs/uno-jev-v1.md)：范围、规则取舍、状态机、AI 协议、存档、交互、配置与验收标准（实现与验收依据）。
- [文档索引](docs/index.md)：按阅读场景查找项目文档。
- [Agent 工作指南](AGENTS.md)：仓库协作约定。

技术栈：Nuxt 4 · Vue 3 · TypeScript · VueUse · Tailwind CSS 4 + `@ayingott/theme`（Paper / Ink 双主题）。规则引擎为纯 TypeScript（`shared/game/`），不依赖框架与网络。

## 使用自己的 Jev API Key

默认使用站点额度（由本站的 TypeSafe 密钥调用）。顶栏的“Jev 设置”可切换为“使用自己的 Key”：

- 选择个人 Key 后，三位 Jev 对手的决策都通过该 Key 调用，**费用由你自己的 TypeSafe 账户承担**；Key 从 [TypeSafe 官方控制台](https://console.typesafe.ai/keys)获取。
- 个人 Key 默认只保留在当前页面内存，刷新后需重新输入；勾选“在此设备记住”后才保存在当前浏览器的独立本地存储（不加密、不等于绝对安全），不会保存到本站服务器。调用时 Key 经同源 HTTPS 请求的专用请求头传给本站服务端，仅当次请求使用，不进入日志、存档或错误响应。
- 多标签页共享同一“已记住”凭据：一页删除（写入删除标记）、替换或取消记住后，其他页面自动同步，不会复活已删除的 Key，也不会用旧 Key 覆盖新保存的 Key；未记住的页内 Key 各自独立。
- 保存 / 删除时如果本地存储写入失败，界面会如实区分“本页已生效”与“持久化结果”（旧副本是否残留），并提供重试；读取失败时保留操作意图，恢复访问后可按原意图重试；另一标签页保存了新 Key 时以冲突提示说明，不会误删。
- 个人模式缺少 Key 或调用失败时不会悄悄改用站点额度；对应的 Jev 回合按明确标识的规则策略继续。
- 站点额度确认耗尽时（由站点运营者显式声明），界面会持续提示“使用自己的 Key”或“继续使用规则对手”，当前对局保留，不需要重开。
- 2026-09-20 核对的 [TypeSafe API 文档](https://docs.typesafe.ai/api#errors)没有可区分“额度耗尽”的错误码（仅 401 Key 无效、422 请求校验、429 限流、529 过载），因此本站不会把限流、过载或鉴权错误说成额度耗尽，也不按调用次数猜测余额。

## 安装

要求 Node.js 24+ 与 pnpm 11（`corepack enable` 或独立安装均可）。

```bash
pnpm install
```

复制 `.env.example` 为 `.env` 并按需填写：

```dotenv
NUXT_TYPESAFE_API_KEY=
NUXT_TYPESAFE_MODEL=jev-1.13.0
NUXT_TYPESAFE_SITE_QUOTA_EXHAUSTED=false
```

- `NUXT_TYPESAFE_API_KEY`：TypeSafe API key，仅服务端使用；本地不填也能玩——AI 决策会走明确标识的规则策略兜底。
- `NUXT_TYPESAFE_MODEL`：Jev 模型名，默认固定 `jev-1.13.0`，不跟随别名升级。
- `NUXT_TYPESAFE_SITE_QUOTA_EXHAUSTED`：设为 `true` 时声明站点额度已确认耗尽（仅影响站点来源；用户自己的 Key 不受影响）。TypeSafe API 没有额度耗尽信号，只能由运营者显式声明，不要从 429/529/鉴权错误推断。

密钥只经服务端运行时读取，不会出现在客户端产物、日志或浏览器存储中。`git check-ignore -v .env` 可确认忽略规则。

## 运行

```bash
pnpm dev            # 开发服务器（默认 http://localhost:3000）
pnpm build          # Node 生产构建（node .output/server/index.mjs 预览）
pnpm build:worker   # Cloudflare Workers 生产构建（cloudflare_module preset + Workers Assets）
pnpm preview:worker # 用 wrangler 在本地预览 Worker 构建（需先 build:worker）
```

- Worker 本地预览会读取 `.dev.vars`（已被 git 忽略）作为本地变量，可在其中放置测试用的假密钥，避免消耗真实额度。
- 生产部署使用 `npx wrangler deploy`；`NUXT_TYPESAFE_API_KEY` 通过 `wrangler secret put` 注入，不写入 `wrangler.jsonc` 的 `vars`。

## 测试与检查

```bash
pnpm test           # vitest 全量测试（R1..R7、S1..S4、A1..A5，全部使用 mock，不依赖 API key）
pnpm test:watch     # 监听模式
pnpm typecheck      # nuxt typecheck（vue-tsc）
pnpm lint           # eslint（@antfu/eslint-config）
pnpm lint:fix       # 自动修复
```

测试目录与验收编号对应：`tests/rules/`（R1..R7 规则引擎）、`tests/save/`（S1/S2 存档往返与校验）、`tests/session/`（S3/S4 保存时机、失败处理与多标签页锁、A3 客户端 AI 调度 mock 矩阵、K 系凭据配置与调度）、`tests/ai/`（A1/A2/A4 信息隔离、候选稳定性与确定性兜底）、`tests/server/`（A2/A3/A5 请求校验、上游错误映射与密钥隔离、K 系凭据来源与额度开关）、`tests/components/`（界面组件行为：出牌动作、Jev 暂停提示、凭据设置与引导提示）。

真实 TypeSafe API 的联通、延迟与费用验证不在 v1 范围内；对战强度未实测，不构成任何胜率或响应时间承诺。

## 配置摘要

| 位置 | 用途 |
|---|---|
| `.env` / `NUXT_TYPESAFE_API_KEY` | 本地开发的服务端密钥（被 git 忽略，不入库） |
| `.env` / `NUXT_TYPESAFE_MODEL` | 服务端模型名，默认 `jev-1.13.0` |
| `.env` / `NUXT_TYPESAFE_SITE_QUOTA_EXHAUSTED` | 站点额度确认耗尽的运营者声明（`true` 生效，仅影响站点来源） |
| `.dev.vars` | `wrangler dev` 本地变量（优先于 `.env`，被 git 忽略） |
| Cloudflare Worker Secret | 生产密钥注入方式（`wrangler secret put NUXT_TYPESAFE_API_KEY`） |
| 浏览器 `unojev:save` / `unojev:theme` / `unojev:settings` | 对局槽位 / 主题意图 / 偏好，均在浏览器本地 |
| 浏览器 `unojev:jev-key` | 个人 Jev Key（仅勾选“在此设备记住”后写入；浏览器本地，不加密；删除时写入不含 Key 的删除标记用于跨标签页同步） |

## 目录结构

```
shared/game/     纯 TypeScript 规则引擎（牌组、状态机、合法动作、AI 视角投影、候选与兜底）
shared/ai/       浏览器 ↔ Worker 的 AI 决策协议合同（含凭据来源与个人 Key 请求头）
app/composables/ 会话编排（useUnoGame）、持久化、多标签页锁、AI 调度、Jev 凭据（useJevCredentials）、偏好
app/components/game/ 牌桌界面组件（含 Jev 设置对话框与凭据提示条）
app/pages/       唯一页面（入口 / 对局 / 只读 / 存档异常）
server/api/ai/   POST /api/ai/decision 同源决策代理
server/utils/    决策处理核心（可注入 fetch 与超时，独立测试）
tests/           按验收编号组织的测试
```

## 已知限制

- 单机娱乐产品：完整状态在浏览器中，可被开发者工具读取改写，不具备防作弊能力；Worker 只验证请求自洽。
- v1 不提供 +4 质疑动作（系统严格校验 +4 合法性），无真人联机、计分、排行、离线冷启动。
- 同一浏览器只保留一个对局槽位；多标签页通过 Web Locks 独占锁控制，不支持抢占。
- 800×360 横屏下关键操作区需要少量垂直滚动到达（无遮挡）。
- Jev 的 UNO 对战强度与真实调用表现尚未验证。
