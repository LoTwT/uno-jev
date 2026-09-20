<script setup lang="ts">
/**
 * 应用外壳：SSR 只输出外壳与非对局内容。
 * 首屏绘制前应用已保存主题意图或系统偏好，避免错误主题闪烁；
 * 游戏状态仍只在客户端恢复。
 */
const { reducedMotion } = usePreferences()

// 用户的"减少动态"设置绑定到根节点，关闭位移动画（CSS 见 main.css）
watch(reducedMotion, (value) => {
  if (import.meta.client) {
    document.documentElement.setAttribute('data-reduced-motion', String(value))
  }
}, { immediate: true })

useHead({
  title: 'UnoJev — 与 Jev 一起玩 UNO',
  meta: [
    { name: 'description', content: '单人对战三位 Jev AI 的 UNO 游戏，对局保存在浏览器本地。' },
  ],
  script: [
    {
      // 预挂载主题：读取 unojev:theme（VueUse JSON 序列化）并应用到 <html>
      innerHTML: `(function(){try{var t=localStorage.getItem('unojev:theme');var d=t?JSON.parse(t):'auto';if(d==='dark'||(d!=='light'&&window.matchMedia('(prefers-color-scheme: dark)').matches)){document.documentElement.classList.add('dark');}}catch(e){}})();`,
    },
  ],
  htmlAttrs: {
    lang: 'zh-CN',
  },
})
</script>

<template>
  <div class="min-h-dvh flex flex-col bg-[var(--surface-canvas)] text-[var(--text-primary)]">
    <NuxtPage />
  </div>
</template>
