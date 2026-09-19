# UnoJev

UnoJev 是 1 位真人与 3 位 Jev AI 对手的单人 UNO 游戏。经典 108 张基础牌、单局胜负，默认中文界面，面向桌面和手机。对局完整保存在浏览器本地；服务端只代理受限的 Jev 决策请求。

- [v1 产品与技术规格](docs/specs/uno-jev-v1.md)：范围、规则取舍、状态机、AI 协议、存档、交互、配置与验收标准（实现与验收依据）。
- [文档索引](docs/index.md)：按阅读场景查找项目文档。
- [Agent 工作指南](AGENTS.md)：仓库协作约定。

技术栈：Nuxt 4 · Vue 3 · TypeScript · VueUse · Tailwind CSS 4 + `@ayingott/theme`（Paper / Ink 双主题）。规则引擎为纯 TypeScript（`shared/game/`），不依赖框架与网络。

## 安装

要求 Node.js 24+ 与 pnpm 11（`corepack enable` 或独立安装均可）。

```bash
pnpm install
```

复制 `.env.example` 为 `.env` 并按需填写：

```dotenv
NUXT_TYPESAFE_API_KEY=
NUXT_TYPESAFE_MODEL=jev-1.13.0
```

- `NUXT_TYPESAFE_API_KEY`：TypeSafe API key，仅服务端使用；本地不填也能玩——AI 决策会走明确标识的规则策略兜底。
- `NUXT_TYPESAFE_MODEL`：Jev 模型名，默认固定 `jev-1.13.0`，不跟随别名升级。

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

测试目录与验收编号对应：`tests/rules/`（R1..R7 规则引擎）、`tests/save/`（S1/S2 存档往返与校验）、`tests/session/`（S3/S4 保存时机、失败处理与多标签页锁、A3 客户端 AI 调度 mock 矩阵）、`tests/ai/`（A1/A2/A4 信息隔离、候选稳定性与确定性兜底）、`tests/server/`（A2/A3/A5 请求校验、上游错误映射与密钥隔离）。

真实 TypeSafe API 的联通、延迟与费用验证不在 v1 范围内；对战强度未实测，不构成任何胜率或响应时间承诺。

## 配置摘要

| 位置 | 用途 |
|---|---|
| `.env` / `NUXT_TYPESAFE_API_KEY` | 本地开发的服务端密钥（被 git 忽略，不入库） |
| `.env` / `NUXT_TYPESAFE_MODEL` | 服务端模型名，默认 `jev-1.13.0` |
| `.dev.vars` | `wrangler dev` 本地变量（优先于 `.env`，被 git 忽略） |
| Cloudflare Worker Secret | 生产密钥注入方式（`wrangler secret put NUXT_TYPESAFE_API_KEY`） |
| 浏览器 `unojev:save` / `unojev:theme` / `unojev:settings` | 对局槽位 / 主题意图 / 偏好，均在浏览器本地 |

## 目录结构

```
shared/game/     纯 TypeScript 规则引擎（牌组、状态机、合法动作、AI 视角投影、候选与兜底）
shared/ai/       浏览器 ↔ Worker 的 AI 决策协议合同
app/composables/ 会话编排（useUnoGame）、持久化、多标签页锁、AI 调度、偏好
app/components/game/ 牌桌界面组件
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
