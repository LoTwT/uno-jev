// @tscheck
import antfu from '@antfu/eslint-config'

export default antfu(
  {
    vue: true,
    typescript: true,
    stylistic: {
      quotes: 'single',
      semi: false,
    },
    ignores: [
      '.nuxt/**',
      '.output/**',
      'node_modules/**',
      'coverage/**',
      'dist/**',
      '.wrangler/**',
      '.data/**',
      // YAML 配置文件不属于 lint 范围（pnpm-workspace.yaml 由 pnpm 解析）
      'pnpm-workspace.yaml',
      // 规格与文档的正文（含代码块）是权威内容，不做样式格式化
      'docs/**',
    ],
  },
  {
    // 规则层与测试是纯 Node / 纯浏览器逻辑，禁止依赖 Vue 生态的全局
    files: ['shared/**', 'tests/**', 'server/**'],
    rules: {},
  },
)
