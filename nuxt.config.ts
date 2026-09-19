import tailwindcss from '@tailwindcss/vite'

// Nuxt 4 应用配置：SSR 外壳 + 客户端对局；私有运行时配置仅服务端可读。
export default defineNuxtConfig({
  compatibilityDate: '2026-09-01',
  devtools: { enabled: false },

  css: ['~/assets/css/main.css'],

  // components/game/ 下的组件不加路径前缀，直接以组件名使用
  components: [{ path: '~/components', pathPrefix: false }],

  vite: {
    plugins: [tailwindcss()],
  },

  runtimeConfig: {
    // 私有配置：仅服务端读取，通过 NUXT_TYPESAFE_* 环境变量注入
    typesafeApiKey: '',
    typesafeModel: 'jev-1.13.0',
  },

  // SSR 只输出外壳与非对局内容；发牌、storage 访问与 AI 调度在客户端初始化后进行
  ssr: true,

  app: {
    head: {
      htmlAttrs: { lang: 'zh-CN' },
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
      ],
    },
  },

  nitro: {
    // Worker 不保存对局、不安排下一回合；生产通过 NITRO_PRESET=cloudflare 构建
  },
})
