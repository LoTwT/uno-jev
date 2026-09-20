/**
 * 安全访问浏览器存储。
 *
 * 读取 window.localStorage 属性本身可能抛 SecurityError（隐私模式、企业策略或
 * 存储被禁用）；任何直接访问都必须受控，否则组件初始化会失败、界面无法渲染。
 * 存储不可用时界面仍须可用：偏好回退内存默认值，对局提供不保存的临时模式。
 */

/** 当前环境是否可访问 localStorage（属性访问受控）。 */
export function localStorageAccessible(): boolean {
  if (typeof window === 'undefined') {
    return false
  }
  try {
    return window.localStorage != null
  }
  catch {
    return false
  }
}

/**
 * 传给 VueUse useLocalStorage 的 window 选项。
 *
 * 存储不可用时返回 null：VueUse 会回退为内存 ref，不会在初始化阶段访问被禁用的存储属性。
 * 类型上 Window 不接受 null，这里按运行时语义显式转换（VueUse 内部以可选链读取 localStorage）。
 */
export function storageWindow(): Window {
  return (localStorageAccessible() ? window : null) as unknown as Window
}
