// =============================================================================
// Prompt Pet - Phase 1（桌宠）+ Phase 2（交互气泡）+ Phase 3（AI 接入）
// [AI-GEN] preload：主进程与渲染进程之间唯一的「安全通道」
//
// 为什么需要它？
//   contextIsolation: true + nodeIntegration: false 之后，renderer.js 里没有
//   require，也拿不到 ipcRenderer。preload 在两者之间开一道受控的小门，
//   只暴露我们明确允许的 7 个方法（白名单），其他能力一律不给。
//
//   ⚠️ Phase 3 没有新增「发请求」的通道，是有意的：
//      DeepSeek 接口实测支持浏览器跨域（预检返回 access-control-allow-origin: null，
//      正好匹配 file:// 页面的不透明来源），所以请求由渲染进程自己用 fetch 发即可。
//      渲染进程仍然拿不到 Node，预加载暴露面没有扩大。
// =============================================================================

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petAPI', {
  /**
   * 切换鼠标穿透。
   * @param {boolean} ignore true = 穿透（点到的是下面的桌面）；false = 桌宠可交互
   */
  setIgnoreMouseEvents(ignore) {
    ipcRenderer.send('pet:set-ignore-mouse-events', Boolean(ignore));
  },

  /**
   * 获取桌宠可活动区域（等价于窗口尺寸），用于拖拽边界限制与气泡定位。
   * @returns {Promise<{ width: number, height: number }>}
   */
  getBounds() {
    return ipcRenderer.invoke('pet:get-bounds');
  },

  /**
   * 获取球体直径，保证 JS 命中检测与 CSS 尺寸永远一致。
   * @returns {Promise<number>}
   */
  getPetSize() {
    return ipcRenderer.invoke('pet:get-pet-size');
  },

  /**
   * 让桌宠窗口获得焦点（Phase 2 新增）。
   * 两个作用：① 气泡打开后能立刻用键盘打字，不必先点一下输入框；
   *          ② 之后用户点桌面别处会让窗口失焦，从而触发 blur 收起气泡。
   */
  focusWindow() {
    ipcRenderer.send('pet:focus-window');
  },

  /**
   * 输入法友好模式（Phase 3.10 新增）。
   *
   * 输入框聚焦时传 true：主进程把窗口从 'screen-saver' 降到普通层级，
   * 让 macOS 的候选词面板不被这块透明全屏窗口盖住；失焦时传 false 恢复置顶。
   * 只接受布尔值，避免渲染进程拿它当通用「改窗口参数」的通道。
   *
   * @param {boolean} on true = 正在用输入法输入
   */
  setImeFriendly(on) {
    ipcRenderer.send('pet:set-ime-friendly', Boolean(on));
  },

  /**
   * 把一段文本写进系统剪贴板（Phase 3 新增，给回答下面的「一键复制」用）。
   *
   * 为什么不直接在渲染进程用 navigator.clipboard？
   *   Clipboard API 要求「安全上下文」。file:// 页面在这一点上不可靠，
   *   一旦判定为非安全上下文，navigator.clipboard 直接是 undefined。
   *   主进程的 clipboard 模块没有这个限制，所以在 Electron 里以它为主，
   *   渲染进程那边再保留 navigator.clipboard / execCommand 两级兜底
   *   （这样在浏览器里打开的预览页也能复制）。
   *
   * @param {string} text 要复制的文本（回答的原始 Markdown）
   * @returns {Promise<boolean>} 是否写入成功
   */
  copyText(text) {
    return ipcRenderer.invoke('pet:copy-text', String(text == null ? '' : text));
  },

  /**
   * 把渲染进程的自检信息报给主进程，由主进程打到终端（Phase 3 新增）。
   * 只有「localStorage 能不能用 / 有没有存过 key」这几个布尔值，
   * 不含 key 本身 —— 日志是给人看的，绝不把密钥写进日志。
   * @param {{localStorage: boolean, hasKey: boolean, cspConnect?: string}} info
   */
  reportReady(info) {
    ipcRenderer.send('pet:renderer-ready', info);
  },
});
