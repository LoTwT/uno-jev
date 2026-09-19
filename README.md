# UnoJev

UnoJev 是计划由 1 位真人与 3 位 Jev AI 对手进行的单人 UNO 游戏，GitHub 仓库名为 `uno-jev`。

v1 采用经典基础牌组与单局胜负，默认中文界面，面向桌面和手机。技术方案为 Nuxt 4、Vue 3、TypeScript、VueUse，以及 `@ayingott/theme` + Tailwind CSS 的 Paper / Ink 双主题。对局保存在浏览器，Cloudflare Workers 仅提供无状态的 Jev 调用接口。

当前处于规格阶段，尚未实现游戏，也没有可运行的应用或开发脚本。Jev 的 UNO 对战强度与真实调用表现尚未验证。

- [v1 产品与技术规格](docs/specs/uno-jev-v1.md)：范围、规则取舍、状态机、AI 协议、存档、交互、配置与验收标准。
- [文档索引](docs/index.md)：按阅读场景查找项目文档。
- [Agent 工作指南](AGENTS.md)：仓库协作约定。

本地密钥配置与 Worker Secret 的约定见规格中的“本地配置与部署”。不要将真实密钥写进文档、前端代码或浏览器存储。
