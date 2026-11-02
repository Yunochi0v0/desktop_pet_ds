// =============================================================================
// Prompt Pet（代码精灵桌面版）
// Phase 1 - Electron 基础框架与桌面透明悬浮
//
// [AI-GEN] 本文件由 AI 生成（Phase 1 work package 的一部分）。
//          是否通过由你本人按 PLAN.md 的 Phase 1 Acceptance Criteria 验收。
//
// ⚠️ 项目结构（以磁盘上的真实情况为准，别凭记忆改）：
//
//     prompt-pet/
//     ├── package.json          <- "main" 必须写成 "src/main.js"
//     └── src/
//         ├── main.js           <- 本文件（__dirname == prompt-pet/src）
//         ├── preload.js        <- 必须存在，否则鼠标穿透完全失效
//         ├── index.html
//         ├── renderer.js
//         └── style.css
//
//   因为 main.js 在 src/ 里，package.json 的入口必须是 "src/main.js"。
//   如果你把它改成 "main.js"，Electron 会报：Unable to find Electron app。
//
// 职责划分（Phase 2/3 会继续沿用）：
//   main.js     —— 主进程：只负责「窗口的真实行为」（透明、置顶、鼠标穿透）
//   renderer.js —— 渲染进程：只负责「什么时候该穿透」（命中检测 + 拖拽）
//   两者通过 preload.js 暴露的 IPC 白名单通信，渲染进程永远拿不到 Node。
// =============================================================================

'use strict';

const {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  clipboard,
  Tray,
  Menu,
  nativeImage,
  globalShortcut,
  powerSaveBlocker,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');

// 桌宠球体直径。必须与 src/style.css 里的 --pet-size 保持一致。
const PET_SIZE = 192;

// -----------------------------------------------------------------------------
// 页面 / preload 的路径：一律用 __dirname 拼绝对路径
//
// 为什么不写 win.loadFile('src/index.html') ？
//   因为 loadFile 的「相对路径」基准是【应用根目录】
//   （app.getAppPath()，也就是 package.json 所在的那个文件夹），
//   而不是 main.js 自己所在的文件夹。很多人以为它相对 main.js，
//   于是把 main.js 换个位置就突然白屏了。
//
//   __dirname 永远指向「本文件所在的文件夹」(prompt-pet/src)，
//   不管你以后把 main.js 挪到哪里，这两行都不用改。
// -----------------------------------------------------------------------------
const INDEX_HTML = path.join(__dirname, 'index.html');
const PRELOAD_JS = path.join(__dirname, 'preload.js');

/** @type {BrowserWindow | null} */
let mainWindow = null; // 主窗口（整个屏幕大小的透明层）
let tray = null; // Phase 3.12：系统托盘图标（必须留引用，否则会被 GC 掉）

// -----------------------------------------------------------------------------
// 安全：只接受来自我们自己窗口的 IPC 调用
// -----------------------------------------------------------------------------
function isTrustedSender(event) {
  const win = BrowserWindow.fromWebContents(event.sender);
  return win !== null && win === mainWindow && !win.isDestroyed();
}

// -----------------------------------------------------------------------------
// [AI-GEN] Phase 3.26：日期与天气小看板
//
// 为什么联网放在主进程：
//   ① 渲染进程是 file:// + CSP 页面，联网白名单越少越好；
//   ② 主进程用 Node 的 fetch 发请求，渲染进程始终拿不到 Node；
//   ③ 超时、HTTP 错误、字段缺失都在这里归一化，渲染进程只处理「成功 / 失败」。
//
// 数据源：Open-Meteo 免费天气 + 免费地名检索（无需 API key）
//   · 天气：渲染进程把当前城市的经纬度传进来，这里拼进 query。
//   · 地名：Phase 3.28 新增，用户在天气页搜索城市 → 拿经纬度 → 存 localStorage。
//   [MANUAL] WEATHER_DEFAULT_LOCATION 是「一次都没选过城市」时的兜底，
//           也是「恢复默认」回到的地方；想换默认城市只改这三行。
// -----------------------------------------------------------------------------
const WEATHER_API_BASE = 'https://api.open-meteo.com/v1/forecast';
const GEOCODING_API_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const WEATHER_DEFAULT_LOCATION = { name: '北京', latitude: 39.9042, longitude: 116.4074 };
const WEATHER_TIMEOUT_MS = 8000;
const WEEKDAY_ZH = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

/**
 * WMO weather code → 中文天气 + 给渲染进程挑台词的分类。
 * 分类只保留：sunny / cloudy / rain / snow / fog / storm / other。
 */
const WMO_WEATHER = {
  0: { label: '晴', kind: 'sunny' },
  1: { label: '晴间多云', kind: 'cloudy' },
  2: { label: '多云', kind: 'cloudy' },
  3: { label: '阴', kind: 'cloudy' },
  45: { label: '雾', kind: 'fog' },
  48: { label: '雾凇', kind: 'fog' },
  51: { label: '毛毛雨', kind: 'rain' },
  53: { label: '小雨', kind: 'rain' },
  55: { label: '中雨', kind: 'rain' },
  56: { label: '冻毛毛雨', kind: 'rain' },
  57: { label: '冻雨', kind: 'rain' },
  61: { label: '小雨', kind: 'rain' },
  63: { label: '中雨', kind: 'rain' },
  65: { label: '大雨', kind: 'rain' },
  66: { label: '冻雨', kind: 'rain' },
  67: { label: '强冻雨', kind: 'rain' },
  71: { label: '小雪', kind: 'snow' },
  73: { label: '中雪', kind: 'snow' },
  75: { label: '大雪', kind: 'snow' },
  77: { label: '雪粒', kind: 'snow' },
  80: { label: '阵雨', kind: 'rain' },
  81: { label: '强阵雨', kind: 'rain' },
  82: { label: '暴雨', kind: 'rain' },
  85: { label: '阵雪', kind: 'snow' },
  86: { label: '强阵雪', kind: 'snow' },
  95: { label: '雷雨', kind: 'storm' },
  96: { label: '雷雨伴冰雹', kind: 'storm' },
  99: { label: '强雷雨伴冰雹', kind: 'storm' },
};

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** 生成 YYYY-MM-DD 星期X；日期用主进程本地时间，和用户桌面时钟一致 */
function formatWeatherDate(date) {
  const d = date instanceof Date ? date : new Date();
  return (
    d.getFullYear() +
    '-' +
    pad2(d.getMonth() + 1) +
    '-' +
    pad2(d.getDate()) +
    ' ' +
    WEEKDAY_ZH[d.getDay()]
  );
}

function describeWeatherCode(rawCode) {
  const code = Number(rawCode);
  if (!Number.isFinite(code)) return { code: -1, label: '未知天气', kind: 'other' };
  const found = WMO_WEATHER[code];
  return found
    ? { code, label: found.label, kind: found.kind }
    : { code, label: '未知天气', kind: 'other' };
}

/** 失败也返回日期：卡片第一行不能因为断网就空着 */
function weatherFailure(dateText, error) {
  const d = new Date();
  return {
    ok: false,
    error: error || '天气获取失败',
    date: dateText || formatWeatherDate(d),
    dateISO:
      d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()),
    weekday: WEEKDAY_ZH[d.getDay()],
    weather: null,
    fetchedAt: Date.now(),
  };
}

/**
 * 归一化渲染进程传来的城市：只信任「名字 + 经纬度」。
 * 坐标非法（缺字段 / 超范围 / 非数字）就退回默认城市，绝不让坏参数打到接口上。
 */
function normalizeWeatherLocation(options) {
  const src = options && typeof options === 'object' ? options : {};
  const latitude = Number(src.latitude);
  const longitude = Number(src.longitude);
  const ok =
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180;
  if (!ok) {
    return {
      name: WEATHER_DEFAULT_LOCATION.name,
      latitude: WEATHER_DEFAULT_LOCATION.latitude,
      longitude: WEATHER_DEFAULT_LOCATION.longitude,
      isDefault: true,
    };
  }
  const name =
    typeof src.name === 'string' && src.name.trim()
      ? src.name.trim().slice(0, 60)
      : latitude.toFixed(2) + ', ' + longitude.toFixed(2);
  return { name, latitude, longitude, isDefault: false };
}

function weatherApiUrl(location) {
  return (
    WEATHER_API_BASE +
    '?latitude=' +
    encodeURIComponent(location.latitude) +
    '&longitude=' +
    encodeURIComponent(location.longitude) +
    '&current_weather=true'
  );
}

async function fetchWeatherAndDate(options) {
  const now = new Date();
  const location = normalizeWeatherLocation(options);
  const dateText = formatWeatherDate(now);
  const dateISO = now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
  const weekday = WEEKDAY_ZH[now.getDay()];

  if (typeof fetch !== 'function') {
    console.error('[PromptPet] 天气：当前 Electron 主进程没有 fetch');
    return weatherFailure(dateText, '天气获取失败');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEATHER_TIMEOUT_MS);

  try {
    const response = await fetch(weatherApiUrl(location), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error('HTTP ' + response.status);
    }

    const data = await response.json();
    // current_weather 是当前接口的字段；同时兼容 Open-Meteo 新版 current 结构。
    const cw = (data && data.current_weather) || (data && data.current) || null;
    if (!cw) throw new Error('响应里没有 current_weather');

    const temperature = Number(
      cw.temperature !== undefined ? cw.temperature : cw.temperature_2m
    );
    const windspeed = Number(
      cw.windspeed !== undefined ? cw.windspeed : cw.wind_speed_10m
    );
    const rawCode =
      cw.weathercode !== undefined ? cw.weathercode : cw.weather_code;
    if (!Number.isFinite(temperature) || !Number.isFinite(windspeed)) {
      throw new Error('温度 / 风速字段无效');
    }

    const condition = describeWeatherCode(rawCode);
    const result = {
      ok: true,
      error: '',
      date: dateText,
      dateISO,
      weekday,
      location: {
        name: location.name,
        latitude: location.latitude,
        longitude: location.longitude,
        isDefault: location.isDefault,
      },
      weather: {
        temperature: Math.round(temperature * 10) / 10,
        windSpeed: Math.round(windspeed * 10) / 10,
        weatherCode: condition.code,
        condition: condition.label,
        kind: condition.kind,
        isDay: cw.is_day === 1 || cw.is_day === true,
        observedAt: cw.time || '',
      },
      fetchedAt: Date.now(),
    };
    console.log(
      '[PromptPet] 天气（' +
        location.name +
        '）：' +
        result.weather.condition +
        ' ' +
        result.weather.temperature +
        '°C / ' +
        result.weather.windSpeed +
        ' km/h'
    );
    return result;
  } catch (err) {
    const reason = err && err.name === 'AbortError' ? '请求超时' : (err && err.message) || '未知错误';
    console.warn('[PromptPet] 天气获取失败：' + reason);
    return weatherFailure(dateText, '天气获取失败');
  } finally {
    clearTimeout(timer);
  }
}

// IPC ⑨（Phase 3.26）：渲染进程请求「日期 + 天气」
// Phase 3.28：options = { name, latitude, longitude }；缺省 / 非法时退回默认城市。
// 返回结构永远包含 date / dateText，weather 可能为 null（失败时）。
ipcMain.handle('get-weather-and-date', async (event, options) => {
  if (!isTrustedSender(event)) {
    return weatherFailure(formatWeatherDate(new Date()), '天气获取失败');
  }
  return fetchWeatherAndDate(options);
});

// IPC ⑩（Phase 3.28）：地名检索。把用户输入的城市名换成经纬度候选，
// 这样「天气页换城市」不依赖任何需要 key 的定位服务，也不需要联网定位权限。
ipcMain.handle('search-location', async (event, query) => {
  if (!isTrustedSender(event)) {
    return { ok: false, error: '无权访问', query: '', results: [] };
  }
  return searchLocations(query);
});

async function searchLocations(query) {
  const keyword = typeof query === 'string' ? query.trim().slice(0, 60) : '';
  if (!keyword) return { ok: true, error: '', query: '', results: [] };
  if (typeof fetch !== 'function') {
    return { ok: false, error: '当前环境不支持网络请求', query: keyword, results: [] };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEATHER_TIMEOUT_MS);
  try {
    const url =
      GEOCODING_API_URL +
      '?name=' +
      encodeURIComponent(keyword) +
      '&count=8&language=zh&format=json';
    const response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const data = await response.json();
    const list = Array.isArray(data && data.results) ? data.results : [];
    const results = list
      .map((item) => {
        const latitude = Number(item && item.latitude);
        const longitude = Number(item && item.longitude);
        const name = String((item && item.name) || '').trim();
        const admin1 = String((item && item.admin1) || '').trim();
        const country = String((item && item.country) || '').trim();
        return {
          id: String((item && item.id) || name),
          name,
          admin1,
          country,
          latitude,
          longitude,
          timezone: String((item && item.timezone) || ''),
          label: [name, admin1, country].filter(Boolean).join(' · '),
        };
      })
      .filter(
        (item) =>
          item.name && Number.isFinite(item.latitude) && Number.isFinite(item.longitude)
      );
    console.log('[PromptPet] 地名检索：' + keyword + ' → ' + results.length + ' 条');
    return { ok: true, error: '', query: keyword, results };
  } catch (err) {
    const reason =
      err && err.name === 'AbortError' ? '请求超时' : (err && err.message) || '未知错误';
    console.warn('[PromptPet] 地名检索失败：' + reason);
    return { ok: false, error: '地区搜索失败', query: keyword, results: [] };
  } finally {
    clearTimeout(timer);
  }
}

// -----------------------------------------------------------------------------
// 启动前自检：路径问题要立刻在终端说清楚，而不是留一个白屏让你猜
// -----------------------------------------------------------------------------
function checkFiles() {
  let ok = true;

  if (!fs.existsSync(INDEX_HTML)) {
    ok = false;
    console.error('[PromptPet] ❌ 找不到页面文件：');
    console.error('             ' + INDEX_HTML);
    console.error('             → 请确认 index.html 和 main.js 在同一个文件夹里。');
  }

  if (!fs.existsSync(PRELOAD_JS)) {
    ok = false;
    console.error('[PromptPet] ❌ 找不到 preload 文件：');
    console.error('             ' + PRELOAD_JS);
    console.error('             → 缺少它，鼠标穿透会完全失效（但拖拽仍可用）。');
  }

  if (ok) {
    console.log('[PromptPet] 文件自检通过：index.html / preload.js 均已找到。');
  }

  return ok;
}

// -----------------------------------------------------------------------------
// 创建透明桌宠窗口
// -----------------------------------------------------------------------------
function createWindow() {
  // 用 workArea 而不是整块屏幕：这样球体不会被 macOS 菜单栏 / Dock 压住。
  const { workArea } = screen.getPrimaryDisplay();

  mainWindow = new BrowserWindow({
    x: workArea.x,
    y: workArea.y,
    width: workArea.width,
    height: workArea.height,

    // —— 你要求的四项核心配置 ——
    transparent: true, // 1. 全透明背景（桌面直接透出来）
    frame: false, // 2. 无系统边框
    alwaysOnTop: true, // 3. 始终置顶
    skipTaskbar: true, // 4. 不显示任务栏图标

    // —— 透明悬浮窗口必须补上的配套项，否则会出现各种诡异现象 ——
    resizable: false, // 透明 + 可缩放 = 已知的渲染错乱
    movable: false, // 窗口不移动，球体靠 CSS 在窗口内移动
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false, // 关掉窗口阴影，否则透明区域会出现方形暗边
    backgroundColor: '#00000000', // ARGB 全透明，防止闪白
    acceptFirstMouse: true, // macOS：窗口未聚焦时也能一次点击命中
    // 明确写出可聚焦：输入框要能拿到键盘焦点，输入法（IME）也依赖它。
    // 默认值就是 true，但这项一旦被谁改成 false，症状是「能点开气泡却打不了字」，
    // 排查起来很绕，所以显式声明。
    focusable: true,
    show: false, // 等 ready-to-show 再显示，避免白屏闪烁

    webPreferences: {
      preload: PRELOAD_JS,
      contextIsolation: true, // 渲染进程与 preload 隔离
      nodeIntegration: false, // 渲染进程禁止直接使用 Node
      sandbox: true, // 开启沙箱
      devTools: true,
    },
  });

  // 把置顶层级抬到 'screen-saver'，保证能盖住全屏应用
  mainWindow.setAlwaysOnTop(true, 'screen-saver');

  // macOS：切换桌面 / 进入全屏应用时桌宠依然可见
  if (process.platform === 'darwin') {
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }

  // ===========================================================================
  // 核心：默认整窗穿透鼠标
  //   ignore = true  -> 鼠标事件穿过窗口，你能点到窗口下面的桌面/图标
  //   { forward: true } -> 虽然穿透，但仍把 mousemove 转发给渲染进程，
  //                        渲染进程才能判断「鼠标是不是碰到了球」
  //   ⚠️ 少了 { forward: true }，窗口在穿透状态下收不到 mousemove，
  //      动态穿透逻辑就永远不会被触发。
  // ===========================================================================
  mainWindow.setIgnoreMouseEvents(true, { forward: true });

  // 启动前先确认文件都在
  checkFiles();

  mainWindow.loadFile(INDEX_HTML);

  // 页面加载失败时，把真实原因打到终端 —— 排错时最有用的一行
  mainWindow.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL) => {
      console.error('[PromptPet] ❌ 页面加载失败');
      console.error('             错误码：' + errorCode + '（' + errorDescription + '）');
      console.error('             地址：' + validatedURL);
      console.error('             常见原因：main.js / index.html 的相对位置写错，');
      console.error('                       或者 package.json 的 "main" 字段指向了不存在的文件。');
    }
  );

  // 把渲染进程的警告/错误转到终端，方便排查（例如 preload 没加载）
  // 注意：console-message 的签名在 Electron 35 改过 ——
  //   旧版：(event, level, message, line, sourceId)   level 是数字
  //   新版：(event)，信息在 event.level / event.message 上
  // 这里两种都兼容，免得你装了新版之后这段静默失效。
  mainWindow.webContents.on('console-message', (event, level, message) => {
    const lv = level !== undefined ? level : (event && event.level);
    const msg = message !== undefined ? message : (event && event.message);
    const isProblem =
      lv === 'error' || lv === 'warning' || lv === 2 || lv === 3;
    if (isProblem) console.log('[渲染进程] ' + msg);
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    // npm run dev 时自动打开开发者工具（拆成独立窗口，不会挡住桌宠）
    if (process.env.PET_DEBUG) {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
    // 番茄钟：窗口重开时把当前状态推一次。
    // 渲染进程启动时也会 invoke('pomodoro:state') 兜底，两条路互为保险 ——
    // 渲染进程可能比这个事件更早完成监听，也可能更晚。
    pomoBroadcast('pomodoro:tick', pomoSnapshot());
  });

  // 兜底：窗口整体失焦时一定退出「输入法友好模式」，
  // 不然用户点了桌面别处，桌宠会一直停在普通层级（被别的窗口压住）。
  mainWindow.on('blur', () => setImeFriendly(false));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// -----------------------------------------------------------------------------
// Phase 3.12：系统托盘
//
// 为什么需要它：窗口没有任务栏/Dock 图标（skipTaskbar + app.dock.hide），
// 一旦隐藏就没有任何入口能把桌宠叫回来 —— 托盘是唯一稳定的「复活」路径。
//
// ⚠️ tray 必须存成模块级变量：Electron 的 Tray 一旦被 GC，图标会凭空消失。
// -----------------------------------------------------------------------------
function togglePetWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }

  if (mainWindow.isVisible()) {
    // 隐藏前退出输入法友好模式，保证下次显示时是「置顶」状态
    setImeFriendly(false);
    mainWindow.hide();
    console.log('[PromptPet] 托盘：已隐藏桌宠');
    return;
  }

  mainWindow.show();
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  if (process.platform === 'darwin') {
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  mainWindow.setIgnoreMouseEvents(true, { forward: true });
  console.log('[PromptPet] 托盘：已显示桌宠');
}

function createTray() {
  if (tray) return tray;

  let image = nativeImage.createEmpty();
  try {
    const iconPath = path.join(__dirname, 'assets', 'icon.png');
    if (fs.existsSync(iconPath)) image = nativeImage.createFromPath(iconPath);
  } catch (err) {
    console.warn('[PromptPet] 托盘图标读取失败：' + err.message);
  }
  if (!image.isEmpty()) {
    // 菜单栏用 18pt 左右最合适；给 2x 屏留一点余量，resize 后系统会按需缩放
    image = image.resize({ width: 18, height: 18 });
  } else {
    console.warn('[PromptPet] 缺少 assets/icon.png，托盘会显示为空白图标');
  }

  tray = new Tray(image);
  tray.setToolTip('吃白饭的大肥鱼');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示/隐藏桌宠', click: () => togglePetWindow() },
      { type: 'separator' },
      {
        label: '退出程序',
        click: () => {
          app.isQuitting = true;
          app.quit();
        },
      },
    ])
  );

  console.log('[PromptPet] 托盘已就绪（右键：显示/隐藏桌宠、退出程序）');
  return tray;
}

// -----------------------------------------------------------------------------
// 全局快捷键兜底（macOS 26 菜单栏兼容）
//
// 背景：macOS 26.6 上，未用 Apple 开发者证书签名的进程创建的 NSStatusItem
//      可能只占位、不绘制内容（本机 Electron 为 adhoc 签名，原生 Swift 测试同样不可见）。
//      托盘对象仍然存在，只是看不见，所以保留 Tray 代码，另加不依赖菜单栏的快捷键：
//        ⌃⌥P  显示 / 隐藏桌宠
//        ⌃⌥Q  退出程序
// 若某台机器上快捷键被占用，register 会返回 false，日志里会给出提示。
// -----------------------------------------------------------------------------
let shortcutsRegistered = false;

function registerGlobalShortcuts() {
  if (shortcutsRegistered) return;
  shortcutsRegistered = true;

  const bindings = [
    ['Control+Alt+P', '显示/隐藏桌宠', () => togglePetWindow()],
    [
      'Control+Alt+Q',
      '退出程序',
      () => {
        app.isQuitting = true;
        app.quit();
      },
    ],
  ];

  for (const [accelerator, label, handler] of bindings) {
    const ok = globalShortcut.register(accelerator, handler);
    if (ok) {
      console.log(`[PromptPet] 全局快捷键已注册：${accelerator}（${label}）`);
    } else {
      console.warn(`[PromptPet] 全局快捷键注册失败（可能被其他应用占用）：${accelerator}（${label}）`);
    }
  }
}

// -----------------------------------------------------------------------------
// 输入法友好模式（Phase 3.10）
//
// 问题：macOS 的输入法候选词面板是一个独立的系统窗口，层级大约在
//      「弹出菜单」这一档；而我们把桌宠窗口抬到了 'screen-saver'（1000+），
//      于是候选词面板被这块透明全屏窗口整个盖住 —— 看起来就像「被对话框裁掉了」。
//
// 为什么不是 CSS 的锅：
//      候选词面板不是页面里的 DOM，`overflow: hidden`、`z-index`、`filter`
//      都管不到它。CSS 只能决定「插入点（caret）在哪」，决定不了面板画在谁上面。
//
// 做法：输入框获得焦点时把窗口临时降到普通层级（候选词就能浮上来）；
//      失焦/收起气泡时立刻恢复 'screen-saver'，不影响「盖住全屏应用」的设定。
// -----------------------------------------------------------------------------
let imeFriendly = false;

function setImeFriendly(on) {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;

  const next = Boolean(on);
  if (next === imeFriendly) return;
  imeFriendly = next;

  if (next) {
    // 注意是 setAlwaysOnTop(false) 而不是换一个更低的具名层级：
    // 普通层级 = 跟用户当前窗口同级，系统输入法面板必然在其之上。
    win.setAlwaysOnTop(false);
    console.log('[PromptPet] 输入法友好模式：开（窗口降为普通层级，候选词可见）');
  } else {
    win.setAlwaysOnTop(true, 'screen-saver');
    // 降层级再抬回去之后，macOS 可能把它从「所有桌面/全屏」里摘掉，补一遍
    if (process.platform === 'darwin') {
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }
    console.log('[PromptPet] 输入法友好模式：关（恢复置顶）');
  }
}

// -----------------------------------------------------------------------------
// Phase 3.18：番茄钟（Pomodoro）—— 计时与防休眠都放在主进程
//
// 为什么计时不在渲染进程做：
//   渲染进程会被节流。窗口被别的应用盖住、或者 macOS 进入 App Nap 之后，
//   setInterval 的间隔会被系统拉长，25 分钟能拖成 30 分钟。
//   主进程的定时器不受页面可见性影响，而且「防休眠」本来就只有主进程能做。
//
// 为什么用「绝对结束时间 endsAt」而不是每秒钟减一次：
//   setInterval 一秒一次，遇到系统睡眠 / 卡顿就会丢 tick，累计误差越滚越大。
//   记下 endsAt，每次 tick 用 endsAt - Date.now() 算剩余，丢多少次 tick 都能自愈；
//   机器睡醒后第一次 tick 也能正确结算（该到点了就直接收尾）。
//
// 状态机：idle → focusing → （自动）resting → idle
//   · focusing 期间 powerSaveBlocker.prevent-app-suspension 生效，系统不会休眠；
//   · resting 期间主动释放 —— 休息就是让人离开电脑，这时候还拦着系统休眠是反效果。
// -----------------------------------------------------------------------------
const POMO_DEFAULT_FOCUS_MS = 25 * 60 * 1000;
const POMO_DEFAULT_REST_MS = 5 * 60 * 1000;

/**
 * 允许用环境变量压缩时长，纯粹给验收 / 自动化测试用：
 *   POMO_FOCUS_MS=5000 POMO_REST_MS=3000 npm start
 * 正常启动不设这两个变量，就是标准的 25 / 5 分钟。
 */
function readDurationEnv(name, fallback) {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(Math.max(1000, Math.round(raw)), 180 * 60 * 1000);
}

const POMO_FOCUS_MS = readDurationEnv('POMO_FOCUS_MS', POMO_DEFAULT_FOCUS_MS);
const POMO_REST_MS = readDurationEnv('POMO_REST_MS', POMO_DEFAULT_REST_MS);

const pomo = {
  phase: 'idle', // 'idle' | 'focusing' | 'resting'
  endsAt: 0, // 绝对结束时间（ms），0 表示没在计时
  totalMs: 0, // 本轮总时长，用来算进度 / 给 UI 显示
  tickTimer: 0, // setInterval id
  blockerId: 0, // powerSaveBlocker id，0 表示没有
};

/** 当前快照：渲染进程只认这一个结构，别在两边各算一套 */
function pomoSnapshot() {
  const remainingMs =
    pomo.phase === 'idle' ? 0 : Math.max(0, pomo.endsAt - Date.now());
  return { phase: pomo.phase, remainingMs, totalMs: pomo.totalMs };
}

function pomoBroadcast(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

function pomoArmBlocker() {
  if (pomo.blockerId) return;
  try {
    // 'prevent-app-suspension' = 允许屏幕熄灭、但系统不进入睡眠，
    // 正是「人在敲代码、屏幕可以黑、机器别睡」的场景。
    pomo.blockerId = powerSaveBlocker.start('prevent-app-suspension');
    console.log('[PromptPet] 番茄钟：已阻止系统休眠（id=' + pomo.blockerId + '）');
  } catch (err) {
    // 拿不到就算了，计时本身不受影响，只是机器可能会睡
    console.warn('[PromptPet] 番茄钟：阻止系统休眠失败：' + err.message);
    pomo.blockerId = 0;
  }
}

function pomoReleaseBlocker() {
  if (!pomo.blockerId) return;
  try {
    if (powerSaveBlocker.isStarted(pomo.blockerId)) {
      powerSaveBlocker.stop(pomo.blockerId);
    }
  } catch (err) {
    console.warn('[PromptPet] 番茄钟：释放休眠锁失败：' + err.message);
  }
  pomo.blockerId = 0;
  console.log('[PromptPet] 番茄钟：已释放休眠锁');
}

function pomoClearTimer() {
  if (!pomo.tickTimer) return;
  clearInterval(pomo.tickTimer);
  pomo.tickTimer = 0;
}

/** 每秒一次：算剩余、广播给渲染进程，到点就收尾 */
function pomoTick() {
  if (pomo.phase === 'idle') return;
  const snap = pomoSnapshot();
  if (snap.remainingMs <= 0) {
    pomoFinish();
    return;
  }
  pomoBroadcast('pomodoro:tick', snap);
}

/**
 * 一轮结束。
 * 专注结束 → 自动开始 5 分钟休息（番茄钟的标准循环，也对应
 * 「专注结束后切 sleep 图并提示休息」的需求）；
 * 休息结束 → 回到 idle，由渲染进程 updateBaseState() 恢复日常表情。
 */
function pomoFinish() {
  const finished = pomo.phase;
  pomoClearTimer();
  pomoReleaseBlocker();

  if (finished === 'focusing') {
    pomo.phase = 'resting';
    pomo.totalMs = POMO_REST_MS;
    pomo.endsAt = Date.now() + POMO_REST_MS;
    pomo.tickTimer = setInterval(pomoTick, 1000);
    pomoBroadcast('pomodoro:done', {
      finished: 'focusing',
      next: 'resting',
      ...pomoSnapshot(),
    });
    console.log('[PromptPet] 番茄钟：专注结束，自动进入 ' + Math.round(POMO_REST_MS / 1000) + ' 秒休息');
    return;
  }

  pomo.phase = 'idle';
  pomo.endsAt = 0;
  pomo.totalMs = 0;
  pomoBroadcast('pomodoro:done', {
    finished: finished === 'resting' ? 'resting' : 'idle',
    next: 'idle',
    ...pomoSnapshot(),
  });
  console.log('[PromptPet] 番茄钟：休息结束，回到空闲');
}

/** 开始 / 重新开始一轮（再次点同一项 = 从头计时） */
function pomoStart(phase) {
  const next = phase === 'resting' ? 'resting' : 'focusing';

  pomoClearTimer();
  pomo.phase = next;
  pomo.totalMs = next === 'focusing' ? POMO_FOCUS_MS : POMO_REST_MS;
  pomo.endsAt = Date.now() + pomo.totalMs;

  if (next === 'focusing') pomoArmBlocker();
  else pomoReleaseBlocker();

  pomo.tickTimer = setInterval(pomoTick, 1000);

  const snap = pomoSnapshot();
  pomoBroadcast('pomodoro:tick', snap);
  console.log(
    '[PromptPet] 番茄钟：开始' +
      (next === 'focusing' ? '专注' : '休息') +
      '，时长 ' +
      Math.round(pomo.totalMs / 1000) +
      ' 秒'
  );
  return snap;
}

/** 手动停止：立刻回 idle，并让渲染进程恢复日常表情 */
function pomoStop() {
  pomoClearTimer();
  pomoReleaseBlocker();
  pomo.phase = 'idle';
  pomo.endsAt = 0;
  pomo.totalMs = 0;
  const snap = pomoSnapshot();
  pomoBroadcast('pomodoro:tick', snap);
  console.log('[PromptPet] 番茄钟：已停止');
  return snap;
}

function pomoDispose() {
  pomoClearTimer();
  pomoReleaseBlocker();
  pomo.phase = 'idle';
  pomo.endsAt = 0;
  pomo.totalMs = 0;
}

// -----------------------------------------------------------------------------
// IPC ⑦（Phase 3.18）：番茄钟
//   · pomodoro:state   —— 渲染进程启动时问一次当前状态（窗口重开也能续上）
//   · pomodoro:start   —— 开始专注 / 休息
//   · pomodoro:stop    —— 停止计时
// 主进程 → 渲染进程只有两条推送：pomodoro:tick（每秒）/ pomodoro:done（一轮结束）。
// -----------------------------------------------------------------------------
ipcMain.handle('pomodoro:state', (event) => {
  if (!isTrustedSender(event)) return { phase: 'idle', remainingMs: 0, totalMs: 0 };
  return pomoSnapshot();
});

ipcMain.handle('pomodoro:start', (event, phase) => {
  if (!isTrustedSender(event)) return { phase: 'idle', remainingMs: 0, totalMs: 0 };
  return pomoStart(phase);
});

ipcMain.handle('pomodoro:stop', (event) => {
  if (!isTrustedSender(event)) return { phase: 'idle', remainingMs: 0, totalMs: 0 };
  return pomoStop();
});

// -----------------------------------------------------------------------------
// IPC ①：渲染进程通知「鼠标进入 / 离开桌宠」→ 主进程切换穿透
// 这是整个 Phase 1 最关键的一条链路，务必只允许布尔值。
// -----------------------------------------------------------------------------
ipcMain.on('pet:set-ignore-mouse-events', (event, ignore) => {
  if (!isTrustedSender(event)) return;

  const win = mainWindow;
  if (!win) return;

  if (ignore === true) {
    win.setIgnoreMouseEvents(true, { forward: true });
  } else {
    win.setIgnoreMouseEvents(false);
  }
});

// -----------------------------------------------------------------------------
// IPC ②：渲染进程询问可用的活动区域（= 窗口尺寸），用于拖拽边界限制
// -----------------------------------------------------------------------------
ipcMain.handle('pet:get-bounds', (event) => {
  if (!isTrustedSender(event) || !mainWindow) {
    const { workArea } = screen.getPrimaryDisplay();
    return { width: workArea.width, height: workArea.height };
  }
  const { width, height } = mainWindow.getBounds();
  return { width, height };
});

// -----------------------------------------------------------------------------
// IPC ③：把球体直径交给渲染进程，保证命中检测和真实尺寸永远一致
// -----------------------------------------------------------------------------
ipcMain.handle('pet:get-pet-size', (event) => {
  if (!isTrustedSender(event)) return PET_SIZE;
  return PET_SIZE;
});

// -----------------------------------------------------------------------------
// IPC ④（Phase 2 新增）：让窗口获得焦点
// 气泡打开时调用，好处有两个：
//   ① 键盘输入可以直接进输入框，不用先点一下；
//   ② 用户点桌面别处会让窗口失焦 -> 渲染进程收到 blur -> 自动收起气泡，
//      这就是「点击气泡外部关闭」的实现方式（穿透状态下窗口收不到那次点击，
//      只能靠失焦来感知）。
// -----------------------------------------------------------------------------
// 渲染进程：输入框聚焦/失焦 → 临时降/升窗口层级（见上面的说明）
ipcMain.on('pet:set-ime-friendly', (event, on) => {
  if (!isTrustedSender(event)) return;
  setImeFriendly(on === true);
});

ipcMain.on('pet:focus-window', (event) => {
  if (!isTrustedSender(event) || !mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
  mainWindow.webContents.focus();
});

// -----------------------------------------------------------------------------
// Phase 3.21：剪贴板监听（智能吐槽）
//
// 为什么用「主进程定时轮询」而不是渲染进程的 copy 事件：
//   ① 渲染进程是 file:// 页面，document 上的 copy 事件只覆盖「本页面内」的复制，
//      用户在 VS Code / 终端里复制根本不会冒泡到这里；
//   ② 主进程的 clipboard 模块读的是系统剪贴板，程序在后台也能读到；
//   ③ 轮询间隔 3 秒、每次只读一段文本，开销可以忽略（比监听键盘钩子安全得多，
//      也不需要考虑 macOS 的辅助功能授权）。
//
// 为什么默认「不启动」，等渲染进程说一声：
//   用户在设置里关掉吐槽之后，就不该再每 3 秒读一次剪贴板 —— 那是隐私边界。
//   renderer 初始化时会按 localStorage 发一次 clipboard:set-watch。
// -----------------------------------------------------------------------------
const CLIP_POLL_MS = 3000;
/** 超过这个长度的「代码感」文本才吐槽，短片段不打扰 */
const CLIP_CODE_MIN_CHARS = 500;
/** 一篇文章 / 一整个文件粘进来时不吐槽（她也不想读 20000 字） */
const CLIP_SKIP_TOO_LONG = 20000;
/** 记住最近多少条已吐槽内容（同一个报错不重复触发） */
const CLIP_SEEN_LIMIT = 30;

/** 报错关键词：用户点名的 Error / Exception / Warning / undefined 都在里面 */
const CLIP_ERROR_RE =
  /\b(error|exception|warning|traceback|undefined|cannot read|is not a function|failed to)\b/i;

/**
 * 「像代码」的粗判：不追求准确，只要能把「复制一大段源码 / 日志」和
 * 「复制一大段散文」区分开就行。宁可漏判，也别把人家的小说当代码吐槽。
 */
const CLIP_CODE_RE =
  /(\bfunction\b|\bconst\b|\blet\b|\bclass\b|\bimport\b|\bexport\b|\bdef\b|\bpublic\b|=>|<\/?[a-z][\w-]*>|\{\s*$|;\s*$)/im;

const clipWatch = {
  timer: 0,
  /** 上一轮异步读取还没回来（防止两轮交错） */
  busy: false,
  /** 是否已经记下「启动时剪贴板里本来是什么」（异步播种完成前不判断） */
  seeded: false,
  /** 上一次读到的原文：剪贴板没变就整段跳过，连正则都不跑 */
  lastText: '',
  /** 我们自己写进剪贴板的内容（点「复制」按钮），不能反过来吐槽自己 */
  selfWritten: '',
  /** 最近吐槽过的指纹（FIFO）：同一段报错只逗她一次 */
  seen: [],
};

/**
 * 判断一段剪贴板文本值不值得吐槽。
 * @param {string} text
 * @returns {'error'|'code'|null} null = 不打扰
 */
function classifyClipboard(text) {
  const raw = typeof text === 'string' ? text : '';
  const trimmed = raw.trim();
  // 太短：多半是 sk-xxx、一个变量名、一句话，没什么好吐槽的
  if (trimmed.length < 12) return null;
  if (trimmed.length > CLIP_SKIP_TOO_LONG) return null;

  if (CLIP_ERROR_RE.test(trimmed)) return 'error';
  if (trimmed.length > CLIP_CODE_MIN_CHARS && CLIP_CODE_RE.test(trimmed)) return 'code';
  return null;
}

/** 指纹：种类 + 长度 + 开头 120 字。不存原文，避免把用户的代码留在内存里 */
function clipFingerprint(kind, text) {
  return kind + '|' + text.length + '|' + text.slice(0, 120);
}

/**
 * 读剪贴板。
 * Electron 45 起主进程的 clipboard 变成了 Promise 接口（readText 返回 Promise），
 * 旧版本是同步返回字符串。两种都得能用，否则新版本上「监听」会永远读到 ''。
 */
async function readClipboardText() {
  try {
    const value = clipboard.readText();
    const text = value && typeof value.then === 'function' ? await value : value;
    return typeof text === 'string' ? text : '';
  } catch (err) {
    // 少数情况下（剪贴板被别的程序独占）读取会抛错，当作空内容即可
    return '';
  }
}

/** 写剪贴板，同样兼容同步 / Promise 两种实现 */
async function writeClipboardText(text) {
  try {
    const value = clipboard.writeText(text);
    if (value && typeof value.then === 'function') await value;
    return true;
  } catch (err) {
    return false;
  }
}

async function clipPollOnce() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // 异步读可能要几十毫秒：上一轮还没回来就跳过，避免两次 poll 交错时重复推送
  if (!clipWatch.seeded || clipWatch.busy) return;

  clipWatch.busy = true;
  let text = '';
  try {
    text = await readClipboardText();
  } finally {
    clipWatch.busy = false;
  }

  if (text === clipWatch.lastText) return; // 没变，什么都不做
  clipWatch.lastText = text;

  if (!text || text === clipWatch.selfWritten) return;

  const kind = classifyClipboard(text);
  if (!kind) return;

  const fp = clipFingerprint(kind, text);
  if (clipWatch.seen.indexOf(fp) !== -1) return; // 同一个报错，不再逗第二次

  clipWatch.seen.push(fp);
  if (clipWatch.seen.length > CLIP_SEEN_LIMIT) clipWatch.seen.shift();

  // 只截前 2000 字给渲染进程：渲染侧只用它挑台词，不需要全文
  mainWindow.webContents.send('clipboard:hint', {
    kind,
    text: text.slice(0, 2000),
    at: Date.now(),
  });
  console.log(
    '[PromptPet] 剪贴板命中（' + kind + '）：' + text.length + ' 字'
  );
}

function clipWatchStart() {
  if (clipWatch.timer) return;
  // 启动时先记下当前内容：开机前就躺在剪贴板里的东西不算「你刚复制」，
  // 否则每次启动都会先被吐槽一次，很吵。
  // 读取是异步的，所以先标记「还没播种」，播种完成前的 poll 一律跳过。
  clipWatch.seeded = false;
  readClipboardText().then((text) => {
    clipWatch.lastText = text;
    clipWatch.selfWritten = text;
    clipWatch.seeded = true;
  });
  clipWatch.timer = setInterval(clipPollOnce, CLIP_POLL_MS);
  console.log('[PromptPet] 剪贴板监听：已开启（每 ' + CLIP_POLL_MS / 1000 + ' 秒一次）');
}

function clipWatchStop() {
  if (!clipWatch.timer) return;
  clearInterval(clipWatch.timer);
  clipWatch.timer = 0;
  console.log('[PromptPet] 剪贴板监听：已关闭');
}

// -----------------------------------------------------------------------------
// IPC ⑤（Phase 3 新增）：把文本写进系统剪贴板
// 给气泡里「一键复制」用。之所以放在主进程：
//   renderer 里 navigator.clipboard 依赖「安全上下文」，file:// 页面不保证可用；
//   主进程的 clipboard 模块永远可用，且这里不涉及任何文件/网络权限，
//   暴露面只是「把一段字符串放进剪贴板」。
// 只接受字符串（用 handle 返回布尔值，渲染进程可以据此给出「已复制」反馈）。
// -----------------------------------------------------------------------------
ipcMain.handle('pet:copy-text', async (event, text) => {
  if (!isTrustedSender(event)) return false;
  if (typeof text !== 'string') return false;

  const ok = await writeClipboardText(text);
  if (!ok) return false;

  // Phase 3.21：记一笔「这是我们自己写的」。
  // 否则用户点一下回答下面的「复制」，3 秒后就会被吐槽「又写 Bug 了？」——
  // 那是她刚说的话，不是用户的 Bug。
  // 写完之后回读一次：系统可能对换行 / 富文本做归一化，直接比对原文会漏水。
  const back = await readClipboardText();
  clipWatch.selfWritten = back;
  clipWatch.lastText = back;
  return true;
});

// -----------------------------------------------------------------------------
// IPC ⑥（Phase 3 新增）：渲染进程报告自己的运行环境，只往终端打日志
// 用途：确认 file:// 页面下 localStorage 到底能不能用（key 就存在那里）。
//   ——如果不能用，保存 key 会失败，而失败必须能在终端里立刻看到，
//     而不是变成一个「保存了但一重启就没了」的谜案。
// -----------------------------------------------------------------------------
ipcMain.on('pet:renderer-ready', (event, info) => {
  if (!isTrustedSender(event)) return;
  const i = info && typeof info === 'object' ? info : {};
  console.log(
    '[PromptPet] 渲染进程就绪：' +
      'localStorage=' +
      (i.localStorage ? '可用' : '❌ 不可用') +
      '，已有 API key=' +
      (i.hasKey ? '是' : '否') +
      '，CSP connect-src=' +
      (i.cspConnect || '(未读取)')
  );
});

// -----------------------------------------------------------------------------
// IPC ⑧（Phase 3.21）：开关剪贴板监听
//   由渲染进程按 localStorage 里的设置决定 —— 关掉之后主进程立刻停止读剪贴板，
//   而不是「继续读、读到了再丢掉」（那样隐私上说不通）。
// -----------------------------------------------------------------------------
ipcMain.on('clipboard:set-watch', (event, on) => {
  if (!isTrustedSender(event)) return;
  if (on === true) clipWatchStart();
  else clipWatchStop();
});

// -----------------------------------------------------------------------------
// 应用生命周期
// -----------------------------------------------------------------------------

// 单实例锁：避免你反复 npm start 之后桌面上出现一叠球
// （调试时如果需要多开，把下面 4 行注释掉即可）
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) mainWindow.show();
  });

  app.whenReady().then(() => {
    // macOS 的 skipTaskbar 不生效，要显式隐藏 Dock 图标
    if (process.platform === 'darwin' && app.dock) {
      app.dock.hide();
    }

    createWindow();
    createTray();
    registerGlobalShortcuts();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  // 番茄钟：退出前务必释放休眠锁，否则系统会一直被拦着不睡
  pomoDispose();
  // 剪贴板轮询：停掉，别让定时器拖住退出流程
  clipWatchStop();
});

app.on('before-quit', () => {
  if (tray) {
    tray.destroy();
    tray = null;
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
