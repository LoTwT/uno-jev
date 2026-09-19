/**
 * 偏好与主题：单一事实来源管理。
 *
 * 主题意图保存在 unojev:theme（auto/light/dark），useColorMode 的内部持久化
 * 设为 storageKey: null，通过其 store 同步意图和实际根节点类，不建立第二份偏好；
 * 其他偏好保存在 unojev:settings，可在各标签页同步，非法值回退默认值。
 */
import { useColorMode, useLocalStorage, usePreferredReducedMotion } from '@vueuse/core'
import { computed, onMounted, watch } from 'vue'

export type ThemeIntent = 'auto' | 'light' | 'dark'
export type ReducedMotionIntent = 'system' | 'reduce'

export const THEME_STORAGE_KEY = 'unojev:theme'
export const SETTINGS_STORAGE_KEY = 'unojev:settings'

export interface GameSettings {
  schemaVersion: 1
  reducedMotion: ReducedMotionIntent
}

const THEME_VALUES: ThemeIntent[] = ['auto', 'light', 'dark']
const MOTION_VALUES: ReducedMotionIntent[] = ['system', 'reduce']

function normalizeTheme(value: unknown): ThemeIntent {
  return THEME_VALUES.includes(value as ThemeIntent) ? value as ThemeIntent : 'auto'
}

export function usePreferences() {
  // 主题意图：跨标签页同步；非法偏好值回退默认值
  const themeIntent = useLocalStorage<ThemeIntent>(THEME_STORAGE_KEY, 'auto', {
    serializer: {
      read: raw => normalizeTheme(raw !== null && raw !== '' ? JSON.parse(raw) : 'auto'),
      write: value => JSON.stringify(normalizeTheme(value)),
    },
    listenToStorageChanges: true,
  })

  const settings = useLocalStorage<GameSettings>(SETTINGS_STORAGE_KEY, { schemaVersion: 1, reducedMotion: 'system' }, {
    serializer: {
      read: (raw) => {
        try {
          const parsed = raw === null || raw === '' ? null : JSON.parse(raw) as Partial<GameSettings>
          const reducedMotion = MOTION_VALUES.includes(parsed?.reducedMotion as ReducedMotionIntent)
            ? parsed!.reducedMotion as ReducedMotionIntent
            : 'system'
          return { schemaVersion: 1, reducedMotion }
        }
        catch {
          return { schemaVersion: 1, reducedMotion: 'system' }
        }
      },
      write: value => JSON.stringify(value),
    },
    // 设置不因开始新局而清除；不自动写入默认值
    writeDefaults: false,
    listenToStorageChanges: true,
  })

  // useColorMode 只负责应用；持久化由 themeIntent 单独承担
  const colorMode = useColorMode({ storageKey: null })
  onMounted(() => {
    colorMode.store.value = themeIntent.value
    watch(themeIntent, (intent) => {
      colorMode.store.value = intent
    })
  })

  const systemReducedMotion = usePreferredReducedMotion()
  const reducedMotion = computed(() => {
    if (settings.value.reducedMotion === 'reduce') {
      return true
    }
    return settings.value.reducedMotion === 'system' && systemReducedMotion.value === 'reduce'
  })

  function setTheme(intent: ThemeIntent) {
    themeIntent.value = intent
  }

  function setReducedMotion(intent: ReducedMotionIntent) {
    settings.value = { schemaVersion: 1, reducedMotion: intent }
  }

  return {
    themeIntent,
    setTheme,
    settings,
    setReducedMotion,
    reducedMotion,
  }
}
