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

  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  let image = nativeImage.createEmpty();
  try {
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
// IPC ⑤（Phase 3 新增）：把文本写进系统剪贴板
// 给气泡里「一键复制」用。之所以放在主进程：
//   renderer 里 navigator.clipboard 依赖「安全上下文」，file:// 页面不保证可用；
//   主进程的 clipboard 模块永远可用，且这里不涉及任何文件/网络权限，
//   暴露面只是「把一段字符串放进剪贴板」。
// 只接受字符串（用 handle 返回布尔值，渲染进程可以据此给出「已复制」反馈）。
// -----------------------------------------------------------------------------
ipcMain.handle('pet:copy-text', (event, text) => {
  if (!isTrustedSender(event)) return false;
  if (typeof text !== 'string') return false;

  clipboard.writeText(text);
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

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('before-quit', () => {
  if (tray) {
    tray.destroy();
    tray = null;
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
