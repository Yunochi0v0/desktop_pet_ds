// =============================================================================
// Prompt Pet - Phase 1（桌宠）+ Phase 2（交互气泡）+ Phase 3（AI 接入）
// [AI-GEN] preload：主进程与渲染进程之间唯一的「安全通道」
//
// 为什么需要它？
//   contextIsolation: true + nodeIntegration: false 之后，renderer.js 里没有
//   require，也拿不到 ipcRenderer。preload 在两者之间开一道受控的小门，
//   只暴露明确允许的方法（白名单），其他能力一律不给。
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
   * [AI-GEN] Phase 3.26：获取「日期 + 实时天气」。
   * 网络请求在主进程完成，渲染进程只拿到归一化后的数据：
   *   { ok, date, dateISO, weekday, location, weather: { temperature, windSpeed, condition, kind, ... } }
   * 失败时 ok=false，天气页显示“天气获取失败”。
   *
   * Phase 3.28：options 可选，{ name, latitude, longitude } 指定查询城市；
   * 不传（或坐标非法）时主进程退回默认城市。
   * @param {{ name?: string, latitude?: number, longitude?: number }} [options]
   * @returns {Promise<object>}
   */
  getWeatherAndDate(options) {
    return ipcRenderer.invoke('get-weather-and-date', options);
  },

  /**
   * [AI-GEN] Phase 3.28：把城市名检索成经纬度候选。
   * 数据源是 Open-Meteo 的免费地名接口，主进程代发，渲染进程不直接联网。
   *   { ok, query, results: [{ id, name, admin1, country, latitude, longitude, label }] }
   * @param {string} query 用户输入的城市名，例如「杭州」
   * @returns {Promise<object>}
   */
  searchLocation(query) {
    return ipcRenderer.invoke('search-location', query);
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

  // ---------------------------------------------------------------------------
  // Phase 3.18：番茄钟
  //
  // 计时器住主进程（渲染进程会被系统节流），这里只做「问状态 / 下命令 / 收推送」。
  // 两条推送都是**只把数据交出去**，不暴露 event 对象 —— 渲染进程拿不到
  // sender，也就没法反向操作其它窗口。
  // ---------------------------------------------------------------------------

  /**
   * 开始一轮计时。
   * @param {'focusing'|'resting'} phase
   * @returns {Promise<{phase: string, remainingMs: number, totalMs: number}>}
   */
  pomodoroStart(phase) {
    return ipcRenderer.invoke(
      'pomodoro:start',
      phase === 'resting' ? 'resting' : 'focusing'
    );
  },

  /** 停止计时，回到 idle */
  pomodoroStop() {
    return ipcRenderer.invoke('pomodoro:stop');
  },

  /** 当前状态（窗口重开 / 首屏兜底用） */
  pomodoroState() {
    return ipcRenderer.invoke('pomodoro:state');
  },

  /**
   * 每秒一次的剩余时间推送。
   * @param {(snapshot: {phase: string, remainingMs: number, totalMs: number}) => void} handler
   * @returns {() => void} 取消订阅
   */
  onPomodoroTick(handler) {
    const listener = (_event, snapshot) => {
      if (typeof handler === 'function') handler(snapshot);
    };
    ipcRenderer.on('pomodoro:tick', listener);
    return () => ipcRenderer.removeListener('pomodoro:tick', listener);
  },

  /**
   * 一轮结束时推送一次。
   * @param {(payload: {finished: string, next: string, phase: string, remainingMs: number, totalMs: number}) => void} handler
   * @returns {() => void} 取消订阅
   */
  onPomodoroDone(handler) {
    const listener = (_event, payload) => {
      if (typeof handler === 'function') handler(payload);
    };
    ipcRenderer.on('pomodoro:done', listener);
    return () => ipcRenderer.removeListener('pomodoro:done', listener);
  },

  // ---------------------------------------------------------------------------
  // Phase 3.21：剪贴板监听
  //   开关在主进程（它才拿得到系统剪贴板），渲染进程只说「开 / 关」。
  //   命中时主进程推一条 { kind, text, at }，渲染进程决定说什么。
  // ---------------------------------------------------------------------------

  /**
   * 开 / 关剪贴板轮询。关掉后主进程立刻停表，不再读剪贴板。
   * @param {boolean} on
   */
  setClipboardWatch(on) {
    ipcRenderer.send('clipboard:set-watch', on === true);
  },

  /**
   * 剪贴板命中推送。
   * @param {(payload: {kind: 'error'|'code', text: string, at: number}) => void} handler
   * @returns {() => void} 取消订阅
   */
  onClipboardHint(handler) {
    const listener = (_event, payload) => {
      if (typeof handler === 'function') handler(payload);
    };
    ipcRenderer.on('clipboard:hint', listener);
    return () => ipcRenderer.removeListener('clipboard:hint', listener);
  },
});
