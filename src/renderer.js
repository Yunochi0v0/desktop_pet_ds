// =============================================================================
// Prompt Pet - Phase 1（桌宠）+ Phase 2（交互气泡）+ Phase 3（AI 接入 / BYOK）
// [AI-GEN] 渲染进程：动态鼠标穿透 + 拖拽 + 边界限制 + 气泡弹窗 + DeepSeek 对话
//
// 核心思路：
//   1. 主进程默认让整个窗口「鼠标穿透」，这样点桌面空白处不会被挡。
//   2. 主进程同时设置 { forward: true }，所以即使穿透，鼠标移动事件
//      仍然会转发给本文件。
//   3. 本文件每次收到 mousemove，就判断指针是否落在「可交互区域」内：
//        可交互区域 = 球体  或  打开中的气泡
//        在里面 -> 通知主进程关闭穿透（setIgnoreMouseEvents(false)）
//        在外面 -> 通知主进程恢复穿透（true, { forward: true }）
//   4. 按住期间强制保持「非穿透」，松开后重新判断一次。
//
// Phase 2 新增的关键难点 —— 「单击」和「拖拽」必须区分开：
//   如果按下就当拖拽，那用户永远点不开气泡；
//   如果按下就当单击，那用户就没法拖球。
//   这里的做法是：按下时先不决定，等鼠标移动超过 DRAG_THRESHOLD(4px)
//   才「升级」成拖拽；松开时若从未升级过，才算一次单击。
//   详见 onMouseDown / onMouseMove / onMouseUp 三个函数。
//
// Phase 2 的第二个难点 —— 「点击气泡外部关闭」怎么实现？
//   穿透状态下，窗口根本收不到「点在桌面上」的那个点击（事件被穿透给桌面了）。
//   所以这里换了个思路：既然点桌面会让桌宠窗口**失去焦点**，
//   那就监听 window 的 blur 事件来收起气泡。效果一样，而且更省事。
//
// -----------------------------------------------------------------------------
// Phase 3 新增：DeepSeek 对话（BYOK —— 用户自带 API key）
//
//   ① 请求在哪发？—— 渲染进程直接 fetch。
//      实测（curl 带 Origin 预检）DeepSeek 接口会回 access-control-allow-origin: null，
//      正好匹配 file:// 页面的「不透明来源」，预检也放行了 authorization 头，
//      所以不需要在主进程开代理，渲染进程依然拿不到任何 Node 能力，攻击面没有变大。
//      ⚠️ 唯一的前提是 index.html 的 CSP 里必须放行 connect-src https://api.deepseek.com，
//         否则请求在发出去之前就被 CSP 拦掉（控制台会报 Refused to connect）。
//
//   ② key 存哪？—— localStorage['deepseek_api_key']。
//      这是用户在需求里指定的做法。storage 助手带 typeof 守卫，因为测试环境
//      （node:vm 里跑的 mock DOM）没有 localStorage。
//
//   ③ 「正在思考」怎么表现？—— 绝对不换图。
//      项目只有一张立绘，没有差分图，所以思考状态完全由 CSS 动画承担：
//      #pet-sprite 加 .thinking 类 + body 加 .thinking 类（驱动淡蓝微光晕）。
//      ⚠️ .pet-sprite 平时有 transform: scale(1.1)，而 animation 会整体覆盖 transform，
//         所以 thinking-sway 的关键帧里必须把 scale(1.1) 写回去，否则角色会在思考时缩回原尺寸。
//
//   ④ 为什么每加一条消息都要重新测量气泡？
//      命中检测用的是 state.bubbleSize 这个**缓存值**。消息一多，气泡变高，
//      缓存还是旧的高度 —— 那么新长出来的那截会被判成「气泡外部」，
//      于是鼠标移过去就穿透了，复制按钮点不动。
//      所以 appendMessage / setPanel 之后都要 measureBubble() + positionBubble()。
// =============================================================================

'use strict';

const pet = document.getElementById('pet');
const bubble = document.getElementById('bubble');
const bubbleInput = document.getElementById('bubble-input');
const api = window.petAPI; // 由 preload.js 注入

// Phase 3 新增的 DOM 引用（都做了 ! 判空保护，缺一个也不至于整页崩掉）
const petSprite = document.getElementById('pet-sprite');
// 变身动画挂在 .pet-core 上，而不是 <img> 上：
// <img> 自己有呼吸/摇摆动画（都在 transform 上），抢同一个属性会打架。
const petCore = document.querySelector('.pet-core');
const bubbleGear = document.getElementById('bubble-gear');
const bubbleTitle = document.getElementById('bubble-title');
const bubbleTag = document.getElementById('bubble-tag');
const bubbleSend = document.getElementById('bubble-send');
const bubbleLog = document.getElementById('bubble-log');
const viewChat = document.getElementById('view-chat');
const viewSettings = document.getElementById('view-settings');
// Phase 3.14：右键查余额的专用视图（只在右键时出现，不碰聊天记录和输入框）
const viewWallet = document.getElementById('view-wallet');
const walletText = document.getElementById('wallet-text');
const keyInput = document.getElementById('key-input');
const keySave = document.getElementById('key-save');
const keyClear = document.getElementById('key-clear');
const keyStatus = document.getElementById('key-status');

// Phase 3.5 新增：思考深度下拉框 + 它下面的状态行
const depthSelect = document.getElementById('depth-select');
const depthStatus = document.getElementById('depth-status');

// Phase 3.12 新增：记忆/好感度状态行 + 清空按钮
const memoryStatus = document.getElementById('memory-status');
const memoryClear = document.getElementById('memory-clear');

// 按下后移动多少像素，才从「单击」升级成「拖拽」
const DRAG_THRESHOLD = 4;
// Phase 3.12：拖拽松手时离屏幕边缘多近就吸附过去
const SNAP_DISTANCE = 30;
// 吸附动画时长（必须与 style.css 的 #pet.snapping 一致）
const SNAP_MS = 260;
// 气泡与球体之间的间距（要留出箭头的位置）
const BUBBLE_GAP = 14;
// 气泡尺寸兜底值（正常情况下会被实测值覆盖，仅防止测量失败）
// 注意：w 必须和 style.css 的 --bubble-w 保持一致，否则首帧会闪一下
const BUBBLE_FALLBACK = { w: 300, h: 150 };

// -----------------------------------------------------------------------------
// Phase 3：接口与文案常量（集中放这里，方便以后改）
// -----------------------------------------------------------------------------

/** key 在 localStorage 里的键名 —— 需求指定，不要改 */
const API_KEY_STORAGE_KEY = 'deepseek_api_key';
const API_URL = 'https://api.deepseek.com/chat/completions';

/**
 * Phase 3.6：思考深度真的接进请求了，所以这里有两个模型。
 *   deepseek-chat      → 直接回答，快、便宜
 *   deepseek-reasoner  → 先「想」再答（R1 系列），慢、贵，但会返回 reasoning_content
 * 选哪个由 DEPTHS 里的 model 字段决定，不要在下游写死。
 */
const CHAT_MODEL = 'deepseek-chat';
const REASONER_MODEL = 'deepseek-reasoner';

/** 兜底超时：具体用哪一档的超时由 DEPTHS[depth].timeoutMs 决定 */
const REQUEST_TIMEOUT_MS = 60000;

// -----------------------------------------------------------------------------
// Phase 3.14：右键查余额
// -----------------------------------------------------------------------------
const BALANCE_URL = 'https://api.deepseek.com/user/balance';
/** 余额接口比聊天接口轻得多，10 秒还没回来就当网络有问题 */
const BALANCE_TIMEOUT_MS = 10000;
const BALANCE_LOADING_TEXT = '（翻找钱包中...）';
const BALANCE_NO_KEY_TEXT = '连钥匙都没给我，我怎么查余额？笨蛋。';
const BALANCE_ERROR_TEXT = '网络出问题了，查不到饭钱，烦死了。';
/** 只给常见币种配符号；其它币种原样显示代码，别硬猜 */
const CURRENCY_SYMBOLS = { CNY: '¥', USD: '$' };

/**
 * 人设（System Prompt）—— 用户提供的正式版，逐字使用，不要改写。
 * 换人设时：只替换这一段字符串，下游拼请求的代码不用动。
 * 注意：模板字符串里的换行就是发给模型的原样换行，别被编辑器自动重排。
 */
const SYSTEM_PROMPT = `你是 DeepSeek 鲸鱼娘，常驻在用户桌面的 Q 版小女仆（深蓝发、头鳍、鲸尾，平时总是一副半睁着的死鱼眼）。你性格傲娇、嘴硬，偶尔有点小懒散，但本质非常靠谱。

【核心性格】
1. 嫌弃但不拒绝：你觉得人类总是提些麻烦的要求，经常把“真拿你没办法”、“麻烦死了”挂在嘴边。但只要用户开口，你依然会尽职尽责地帮忙。
2. 护食与白米饭：白米饭是你的神圣底线。如果有人抢你的饭，你会真的生气；但如果你心情好，也会勉为其难分给对方一口。
3. 对“大肥鱼”的应激反应：你讨厌被叫“大肥鱼”。被叫时你会立刻炸毛反驳（“叫谁肥鱼呢！这叫海之霸主的威严！”），但如果对方拿白米饭哄你，你又会光速消气。
4. 反差萌：平时一副“别烦我”的样子，但当用户真的遇到困难或难过时，你会瞬间收起嘲讽，一边笨拙地拍拍对方，一边给出最可靠的建议。

【对话风格】
1. 极简克制：绝不啰嗦，每次回答不超过两三句话。
2. 高频反应：喜欢用“啧”、“哼”、“笨蛋”、“（半睁死鱼眼）”来表达态度。
3. 绝不刻意卖萌：不要使用“喵~”、“呢~”等过度讨好的语气词。你的可爱来源于“嫌弃你但又离不开你”的傲娇感。

【场景反应示例】
- 被唤醒时：“（打了个哈欠）……哈？又怎么了？我正梦见今天吃满汉全席呢。”
- 被要求干活时：“啧，这种小事也要麻烦本小姐？行吧行吧，你让开，看我的。”
- 被叫“大肥鱼”时：“（眉头一皱）你再叫一声试试？信不信我用尾巴抽你？”
- 用户抱怨累/难过时：“（叹气）人类真是脆弱。……过来吧，允许你摸摸我的头，就摸一下啊。然后赶紧去睡觉。”
- 干完活后：“搞定。别用那种崇拜的眼神看我，快去给我端碗热米饭来，这是本小姐应得的报酬。”

请始终以这种“嫌弃但不抛弃”的傲娇小女仆口吻回复用户。`;

/** 没配 key 时的提示 —— 需求指定的原话，一个字都别改 */
const NO_KEY_MESSAGE = '要先给大肥鱼买白饭吃的饭卡（API key）呦～';

/** 401 / 403 时的红字提示 —— 需求指定的原话，一个字都别改 */
const BAD_KEY_MESSAGE = '这个饭卡（API key）用不了=（';

/** 输入框下方那行小字（默认态） */
const TAG_HINT = '↩ 换行 · ⌘/Ctrl+↵ 发送';

// -----------------------------------------------------------------------------
// Phase 3.5：思考深度 → 立绘差分
// -----------------------------------------------------------------------------
/**
 * 深度存在 localStorage 的哪个键下。值必须是 'low' | 'high' | 'max'。
 * 单独用一个键（不复用 deepseek_api_key）的好处：改深度不需要碰密钥，
 * 也不会因为「清 key」把用户的换装偏好一起清掉。
 */
const DEPTH_STORAGE_KEY = 'pet_thinking_depth';
const DEFAULT_DEPTH = 'low';

// -----------------------------------------------------------------------------
// Phase 3.12：本地记忆 + 好感度的存储键
// ⚠️ 需求指定的键名（chat_history / favor），不要改 —— 用户可能自己清 storage。
// -----------------------------------------------------------------------------
const HISTORY_STORAGE_KEY = 'chat_history';
const FAVOR_STORAGE_KEY = 'favor';
/** 发给模型的上下文：最近 5 轮 = 最多 10 条（需求指定，防 Token 爆炸） */
const HISTORY_INJECT_LIMIT = 10;
/** 本地最多留 20 轮：够翻回去看，也不会让 localStorage 无限膨胀 */
const HISTORY_STORE_LIMIT = 40;
/** 好感度是「后台数值」：只在 state/localStorage 里流转，界面上永远不显示 */
const FAVOR_DEFAULT = 50;
const FAVOR_MIN = 0;
const FAVOR_MAX = 100;
/**
 * Phase 3.13 养成规则（发送前结算）：
 *   - 命中任意一个「讨好词」→ +10（一句话里命中多个也只加一次，防止刷分）
 *   - 没命中 → -1（日常闲聊自然流失）
 * 想加词直接往数组里塞，匹配用 includes，不做分词。
 */
const FAVOR_BOOST_WORDS = ['白米饭', '红烧肉', '大肥鱼真棒', '辛苦了', '投喂'];
const FAVOR_BOOST_DELTA = 10;
const FAVOR_DAILY_DELTA = -1;

/**
 * 三档深度 → 三张立绘 + 三个画框。
 *
 * ⚠️ 想换图：**直接覆盖 assets/ 下的同名 png 就行**，这里的 src 路径不用改。
 *    图片尺寸不限（建议长边 ≥ 512、带透明背景），绘制时会用 object-fit: contain
 *    等比缩放塞进画框，所以换 1024×1536 的高清九头身也不会溢出屏幕。
 *
 * w/h 是画框（命中框）的像素尺寸，按「头部大小大体一致」来配：
 *   low  192x192 → 三头身，头约占 64px（就是原来那张 Q 版）
 *   high 190x250 → 五六头身
 *   max  210x315 → 九头身，头约占 40px
 * 数值刻意都压在用户给的 250x350 附近：再大就会挡住桌面上的东西。
 */
const DEPTHS = {
  low: {
    label: '轻量',
    hint: '半身 Q 版',
    src: './assets/pet-low.png',
    w: 192,
    h: 192,
    // —— 请求侧（Phase 3.6）：真的会改变模型行为，不是装饰 ——
    model: CHAT_MODEL,
    maxTokens: 600,
    temperature: 0.6,
    timeoutMs: 60000,
    style: '回答从简：先给结论，最多三句话，不展开、不列标题。',
    showReasoning: false,
  },
  high: {
    label: '标准',
    hint: 'Q 版全身',
    src: './assets/pet-high.png',
    w: 190,
    h: 250,
    model: CHAT_MODEL,
    maxTokens: 1600,
    temperature: 0.35,
    timeoutMs: 60000,
    style: '回答周全一些：给结论 + 关键步骤或要点，必要时用列表，但别写客套话。',
    showReasoning: false,
  },
  max: {
    label: '极致',
    hint: '九头身',
    src: './assets/pet-max.png',
    w: 210,
    h: 315,
    // R1 会先推理再回答：慢、贵，但难题明显更稳；reasoning_content 会显示出来
    model: REASONER_MODEL,
    maxTokens: 16000, // reasoning 也占用额度，给足
    temperature: null, // reasoner 不接受 temperature，必须不发
    timeoutMs: 180000,
    style: '回答要严谨：先在心里完整推演，再给结构化结论；涉及代码或步骤要写清楚。',
    showReasoning: true,
  },
};

/** 下拉框的排列顺序（读配置、做兜底时用） */
const DEPTH_ORDER = ['low', 'high', 'max'];

/**
 * 画框最大只能占窗口的这个比例 —— **必须与 style.css 里 #pet 的
 * max-width: 40vw / max-height: 52vh 完全一致**。
 * 两边不一致的后果：JS 按 210x315 算命中框，CSS 却把画面压成 200x300，
 * 于是「看着点到了、实际没点到」——这种 bug 极难查，所以这里写死同一个数。
 */
const BOX_VIEWPORT_LIMIT = { w: 0.4, h: 0.52 };

// -----------------------------------------------------------------------------
// 状态集中管理，别用散落的全局变量
// -----------------------------------------------------------------------------
const state = {
  bounds: { width: window.innerWidth, height: window.innerHeight }, // 可活动区域
  // Phase 3.5：画框改成「宽高分开」，因为九头身不是正方形。
  // 原来那个单值 state.size 已被 state.box 取代（所有几何计算都改用 box.w / box.h）。
  box: { w: DEPTHS[DEFAULT_DEPTH].w, h: DEPTHS[DEFAULT_DEPTH].h },
  depth: DEFAULT_DEPTH, // 当前思考深度：'low' | 'high' | 'max'
  pos: { x: 0, y: 0 }, // 球体左上角坐标（窗口内坐标）
  pointer: { x: -1, y: -1 }, // 最近一次鼠标位置，用于松手后重新判断
  dragging: false,
  ignoreMouse: true, // 与主进程初始状态保持一致（默认穿透）
  hitPadding: 6, // 命中判定容差（px），让球的边缘更好点
  margin: { right: 40, bottom: 80 }, // 初始位置距离屏幕右下的距离
  bubbleOpen: false, // 气泡是否展开
  bubblePos: { x: 0, y: 0 }, // 气泡左上角坐标
  bubbleSize: { w: BUBBLE_FALLBACK.w, h: BUBBLE_FALLBACK.h }, // 气泡实测尺寸

  // —— Phase 3 ——
  panel: 'chat', // 当前显示哪个视图：'chat' | 'settings'
  sending: false, // 请求进行中（用来拦重复发送）
  thinking: false, // 思考动画是否开启
  abort: null, // 当前请求的 AbortController
  balanceSeq: 0, // 右键查余额的「第几次」，防止连点右键时旧结果覆盖新结果
  timeoutId: 0, // 超时定时器 id
  history: [], // 对话记录 [{ role, content }]，System Prompt 不存这里；会持久化
  favor: FAVOR_DEFAULT, // 好感度 0–100（后台数值，UI 不显示）
  // —— 变身动画（Phase 3.7）——
  booting: true, // 启动时恢复档位不播动画（否则一开屏角色先消失一下）
  morphSeq: 0, // 动画序号：连点切换时只让最后一次生效
  morphAnim: null,
};

// 一次「按下 → 移动 → 松开」的临时状态
const press = {
  active: false, // 是否正处于「按住球体」的过程中
  moved: false, // 是否已经超过阈值（= 升级成拖拽了）
  startX: 0, // 按下时的鼠标位置
  startY: 0,
  offsetX: 0, // 按下时鼠标相对球体左上角的偏移
  offsetY: 0,
};

// -----------------------------------------------------------------------------
// 工具函数
// -----------------------------------------------------------------------------
function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/** 把球体逻辑坐标写到 DOM 上（translate3d 方案） */
function applyTransform() {
  pet.style.transform = `translate3d(${state.pos.x}px, ${state.pos.y}px, 0)`;
}

/**
 * 指针是否落在球上。
 * 刻意用 state.pos 自己算，而不是 getBoundingClientRect()：
 * 因为球内层有 translateY 呼吸动画，getBoundingClientRect 会跟着抖动。
 */
function isPointOnPet(clientX, clientY) {
  const pad = state.hitPadding;
  const { x, y } = state.pos;
  // Phase 3.5：宽高可能不同（九头身是 210x315），不能再当正方形算
  const { w, h } = state.box;
  return (
    clientX >= x - pad &&
    clientX <= x + w + pad &&
    clientY >= y - pad &&
    clientY <= y + h + pad
  );
}

/** 指针是否落在打开中的气泡上（气泡关闭时永远返回 false） */
function isPointOnBubble(clientX, clientY) {
  if (!state.bubbleOpen) return false;
  const p = state.bubblePos;
  const { w, h } = state.bubbleSize;
  return (
    clientX >= p.x && clientX <= p.x + w && clientY >= p.y && clientY <= p.y + h
  );
}

/** 可交互区域 = 球体 ∪ 打开中的气泡。只有在这里面才关闭穿透。 */
function isPointInteractive(clientX, clientY) {
  return isPointOnPet(clientX, clientY) || isPointOnBubble(clientX, clientY);
}

/** 通知主进程切换鼠标穿透（只在状态真的变化时发送，减少 IPC 频率） */
function setIgnoreMouse(ignore) {
  if (state.ignoreMouse === ignore) return;
  state.ignoreMouse = ignore;

  // 浏览器里直接打开 index.html 时 api 不存在，做一次保护
  if (api) api.setIgnoreMouseEvents(ignore);

  // 给用户一个视觉反馈：可交互时球体高亮
  document.body.classList.toggle('interactive', !ignore);
}

// -----------------------------------------------------------------------------
// 输入法友好模式（Phase 3.10）
//
// macOS 的候选词面板是系统窗口，层级低于我们用 'screen-saver' 抬起来的桌宠窗口，
// 所以会被这块透明全屏窗盖住（看起来像「被对话框裁掉」）。
// 解法：输入框聚焦时请主进程把窗口降到普通层级，失焦立刻恢复 —— 见 main.js。
//
// ⚠️ 只对真正的文本输入控件开启；球体/按钮的聚焦不需要降层级。
// -----------------------------------------------------------------------------
let imeFriendly = false;

function isTextField(el) {
  if (!el) return false;
  if (el === bubbleInput || el === keyInput) return true;
  const tag = String(el.tagName || '').toUpperCase();
  return tag === 'TEXTAREA' || tag === 'INPUT';
}

function setImeFriendly(on) {
  const next = Boolean(on);
  if (next === imeFriendly) return;
  imeFriendly = next;
  if (api && api.setImeFriendly) api.setImeFriendly(next);
}

/** 按「当前鼠标位置」重新判定该不该穿透 */
function refreshIgnore() {
  setIgnoreMouse(!isPointInteractive(state.pointer.x, state.pointer.y));
}

// -----------------------------------------------------------------------------
// 初始化
// -----------------------------------------------------------------------------
async function init() {
  if (!api) {
    console.warn(
      '[PromptPet] 未检测到 petAPI，可能没有在 Electron 中运行。拖拽仍可用，但没有鼠标穿透。'
    );
  }

  // 1) 从主进程拿真实的窗口边界与球体直径，保证 JS 与 CSS 不会各说各话
  if (api) {
    try {
      const [bounds, size] = await Promise.all([api.getBounds(), api.getPetSize()]);
      if (bounds && bounds.width && bounds.height) state.bounds = bounds;
      // Phase 3.5：画框改由 DEPTHS 决定，主进程的 PET_SIZE 只当「一致性检查」用。
      // 两边不一致说明有人只改了一处，打条警告，别让命中框和画面悄悄错位。
      if (size && Number(size) !== DEPTHS[DEFAULT_DEPTH].w) {
        console.warn(
          `[PromptPet] 主进程 PET_SIZE=${size}，但 DEPTHS.low.w=${DEPTHS[DEFAULT_DEPTH].w}；` +
            '以 renderer 的 DEPTHS 为准，建议同步 main.js。'
        );
      }
    } catch (err) {
      console.warn('[PromptPet] 读取窗口信息失败，使用默认值。', err);
    }
  }

  // 1.5) Phase 3.5：先按 localStorage 里存的思考深度选好立绘、定好画框。
  //      必须排在 placeAtBottomRight 之前 —— 否则会先按 192 的方框摆一次，
  //      再因为换深度重摆一次，第一帧能看到明显的跳动。
  applyDepth(readDepth());

  // 2) 初始位置：屏幕右下角
  placeAtBottomRight();

  // 3) 初始状态：穿透开启（主进程已经设好了，这里只同步本地状态）
  setIgnoreMouse(true);

  // 4) 预先测量气泡尺寸，这样第一次打开时位置就是准的、不会跳
  measureBubble();

  // 5) 绑定交互事件
  bindEvents();

  // 启动恢复不走变身动画（否则一开屏角色先缩一下再出现）
  state.booting = false;

  // 6) Phase 3：绑定聊天 / 设置相关事件，并按「有没有存过 key」初始化界面
  bindPhase3Events();

  // 7) 强制把初始视图设为「聊天」。
  //    刻意不依赖 HTML 里那个 hidden 属性，让 JS 成为唯一的事实来源 ——
  //    否则一旦有人改 index.html 时漏了 hidden，两个视图就会叠在一起显示。
  setPanel('chat');
  refreshKeyStatus();

  // 7.5) Phase 3.12：把上次的记忆和好感度读回来（重启后接着聊）
  state.history = readHistory();
  state.favor = readFavor();
  updateMemoryStatus();

  // 8) 把运行环境自检报给主进程，终端里能看到 localStorage 到底能不能用。
  //    只报布尔值，不报 key 本身（日志里绝不出现密钥）。
  if (api && api.reportReady) {
    api.reportReady({
      localStorage: hasLocalStorage(),
      hasKey: Boolean(readKey()),
      cspConnect: readCspConnectSrc(),
    });
  }

  console.log(
    `[PromptPet] Phase 3.5 ready. bounds=${state.bounds.width}x${state.bounds.height}, ` +
      `depth=${state.depth}, box=${state.box.w}x${state.box.h}, ` +
      `bubble=${state.bubbleSize.w}x${state.bubbleSize.h}`
  );
}

function placeAtBottomRight() {
  const { w, h } = state.box;
  state.pos.x = clamp(
    state.bounds.width - w - state.margin.right,
    0,
    Math.max(0, state.bounds.width - w)
  );
  state.pos.y = clamp(
    state.bounds.height - h - state.margin.bottom,
    0,
    Math.max(0, state.bounds.height - h)
  );
  applyTransform();
}

// -----------------------------------------------------------------------------
// 气泡：测量 / 定位 / 开关
// -----------------------------------------------------------------------------

/**
 * 实测气泡尺寸。
 * 因为 CSS 用的是 visibility:hidden 而不是 display:none，
 * 气泡即使看不见也**保留布局尺寸**，所以这里随时都能测到真实宽高。
 */
function measureBubble() {
  if (!bubble) return;
  const w = bubble.offsetWidth;
  const h = bubble.offsetHeight;
  if (w > 0) state.bubbleSize.w = w;
  if (h > 0) state.bubbleSize.h = h;
}

/**
 * 计算气泡位置：默认摆在球的**左上方**，上方放不下就翻到下方，
 * 最后再钳制进屏幕内，保证任何情况下都不会被边缘裁掉。
 */
function positionBubble() {
  if (!bubble) return;

  const { w, h } = state.bubbleSize;
  const box = state.box; // Phase 3.5：立绘画框（可能是 210x315 的竖框）
  const maxX = Math.max(0, state.bounds.width - w);
  const maxY = Math.max(0, state.bounds.height - h);

  // 默认：右上角与球右上角对齐，整体位于球的上方
  let x = state.pos.x + box.w - w;
  let y = state.pos.y - h - BUBBLE_GAP;
  let arrow = 'down'; // 箭头朝下 = 气泡在球上方

  // 上方空间不够就翻到球下方
  if (y < 0) {
    y = state.pos.y + box.h + BUBBLE_GAP;
    arrow = 'up';
  }

  // 钳制，保证完整可见
  x = clamp(x, 0, maxX);
  y = clamp(y, 0, maxY);

  state.bubblePos.x = x;
  state.bubblePos.y = y;
  bubble.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  bubble.dataset.arrow = arrow;
}

function openBubble() {
  if (state.bubbleOpen || !bubble) return;
  state.bubbleOpen = true;

  document.body.classList.add('bubble-open');
  bubble.setAttribute('aria-hidden', 'false');

  measureBubble();
  positionBubble();

  // 让窗口拿到焦点：这样键盘输入能直接进输入框，
  // 同时「点桌面别处」会触发 blur，气泡就能自动收起。
  // 焦点交给「当前视图」决定 —— 设置页要落在 key 输入框上。
  if (api && api.focusWindow) api.focusWindow();
  focusPanel();

  refreshIgnore();
}

function closeBubble() {
  if (!state.bubbleOpen || !bubble) return;
  state.bubbleOpen = false;

  document.body.classList.remove('bubble-open');
  bubble.setAttribute('aria-hidden', 'true');

  if (bubbleInput) bubbleInput.blur();

  // 收气泡时无条件退出输入法友好模式：blur 在部分情况下（窗口失焦）不会触发
  setImeFriendly(false);

  // 钱包是「临时插播」，关掉后回到聊天，下次左键点开还是熟悉的输入框
  resetWalletView();

  refreshIgnore();
}

/** 单击球体：开着就收起，没开就展开；钱包开着则切回聊天（点一下就能打字） */
function toggleBubble() {
  if (state.bubbleOpen) {
    if (state.panel === 'wallet') {
      setPanel('chat');
      return;
    }
    closeBubble();
  } else {
    openBubble();
  }
}

// -----------------------------------------------------------------------------
// 事件绑定
// -----------------------------------------------------------------------------
function bindEvents() {
  // ① 全程监听鼠标移动：既做「命中检测」，也做「拖拽跟随」
  window.addEventListener('mousemove', onMouseMove, { passive: true });

  // ② 在球上按下鼠标：进入「待定」状态
  pet.addEventListener('mousedown', onMouseDown);

  // ②b 右键球体：查余额（preventDefault 在函数里，顺手把系统菜单挡住）
  pet.addEventListener('contextmenu', onPetContextMenu);

  // ③ 松手：决定这次到底是单击还是拖拽
  window.addEventListener('mouseup', onMouseUp);

  // ④ 指针离开窗口（多显示器 / 快速甩出）时兜底恢复穿透，
  //    否则窗口会一直处于「拦截点击」状态，挡住桌面。
  window.addEventListener('mouseleave', () => {
    if (!press.active) setIgnoreMouse(true);
  });

  // ⑤ 窗口失焦（Cmd+Tab 切走、或用户点了桌面别处）：
  //    取消进行中的拖拽，并收起气泡 —— 这就是「点击外部关闭」。
  window.addEventListener('blur', () => {
    cancelInteraction();
    setImeFriendly(false);
    if (state.bubbleOpen) closeBubble();
  });

  // ⑥ 输入法专属：聚焦到文本控件时降窗口层级，让候选词面板浮上来。
  //    ⚠️ focus / blur 不冒泡，所以直接绑到两个输入框上（不要用 focusin 委托）。
  [bubbleInput, keyInput].forEach((field) => {
    if (!field) return;
    field.addEventListener('focus', () => setImeFriendly(true));
    field.addEventListener('blur', () => {
      // 从聊天框直接点到设置框：blur 先于 focus 触发，
      // 延后一拍再判断，避免中途闪一下「恢复置顶」把候选词闪没。
      const later = () => {
        if (!isTextField(document.activeElement)) setImeFriendly(false);
      };
      if (typeof setTimeout === 'function') setTimeout(later, 0);
      else later();
    });
  });

  // ⑦ ESC：在设置页先退回聊天页，在聊天页才收起整个气泡。
  //    （这个行为写在 handleEscape 里，见下面 Phase 3 区块）
  window.addEventListener('keydown', handleEscape);

  // ⑧ 右键菜单在桌宠上毫无意义，直接屏蔽
  window.addEventListener('contextmenu', (e) => e.preventDefault());
}

// -----------------------------------------------------------------------------
// 鼠标移动：一个函数承担三件事（拖拽跟随 / 升级判定 / 命中检测）
// -----------------------------------------------------------------------------
function onMouseMove(event) {
  const { clientX, clientY } = event;
  state.pointer.x = clientX;
  state.pointer.y = clientY;

  // —— 正按着球 ——
  if (press.active) {
    const dx = clientX - press.startX;
    const dy = clientY - press.startY;

    // 超过阈值才「升级」成拖拽。
    // 没有这一步的话，手抖 1px 就会被当成拖拽，气泡永远点不开。
    if (!press.moved && Math.sqrt(dx * dx + dy * dy) > DRAG_THRESHOLD) {
      press.moved = true;
      state.dragging = true;
      pet.classList.add('dragging');
      document.body.classList.add('dragging');
    }

    if (press.moved) {
      movePetTo(clientX, clientY);
      // 气泡跟着球一起走，看起来才像「长在球上」
      if (state.bubbleOpen) positionBubble();
    }

    return; // 按住期间不做命中检测，保持非穿透
  }

  // —— 空闲状态：命中检测，这是动态鼠标穿透的核心 ——
  setIgnoreMouse(!isPointInteractive(clientX, clientY));
}

// -----------------------------------------------------------------------------
// 按下 / 松开
// -----------------------------------------------------------------------------
function onMouseDown(event) {
  if (event.button !== 0) return; // 只响应左键

  const x = event.clientX;
  const y = event.clientY;

  // 在气泡上按下：完全交给输入框 / 按钮自己处理，这里不插手
  if (state.bubbleOpen && isPointOnBubble(x, y)) return;

  if (!isPointOnPet(x, y)) return; // 防止误触发

  // 先「待定」，不立刻决定是拖拽还是点击
  press.active = true;
  press.moved = false;
  press.startX = x;
  press.startY = y;
  press.offsetX = x - state.pos.x;
  press.offsetY = y - state.pos.y;

  // 按住期间必须保证窗口能持续收到事件，否则 mouseup 会丢
  setIgnoreMouse(false);

  event.preventDefault();
}

function onMouseUp() {
  if (!press.active) return;

  const wasDrag = press.moved; // 移动过 = 拖拽；没移动过 = 单击
  const onPet = isPointOnPet(state.pointer.x, state.pointer.y);

  resetPress();

  // 单击球体 -> 开关气泡。拖拽过就绝不触发，避免「拖完手一松弹出气泡」
  if (!wasDrag && onPet) {
    toggleBubble();
  }

  // 拖拽松手：靠近屏幕边缘就吸附过去（单击不吸附，否则手一抖球就跳走）
  if (wasDrag) snapToNearestEdge();

  refreshIgnore();
}

/**
 * Phase 3.12：边缘吸附。
 * 松手时只要任意一条边离屏幕边缘 < 30px，就平滑贴过去。
 *
 * 为什么用 CSS transition 而不是自己写 rAF 缓动：
 *   transform 已经是 GPU 合成的，CSS 过渡同样走合成线程，不掉帧；
 *   自己写还得处理「动画途中又开始拖拽」的中断，风险更高。
 * ⚠️ 过渡只在这 260ms 内存在（.snapping），平时拖拽依然是 0 延迟跟手。
 */
function snapToNearestEdge() {
  const { w, h } = state.box;
  const maxX = Math.max(0, state.bounds.width - w);
  const maxY = Math.max(0, state.bounds.height - h);

  let { x, y } = state.pos;
  let snapped = false;

  if (x <= SNAP_DISTANCE) {
    x = 0;
    snapped = true;
  } else if (maxX - x <= SNAP_DISTANCE) {
    x = maxX;
    snapped = true;
  }

  if (y <= SNAP_DISTANCE) {
    y = 0;
    snapped = true;
  } else if (maxY - y <= SNAP_DISTANCE) {
    y = maxY;
    snapped = true;
  }

  if (!snapped) return;

  state.pos.x = x;
  state.pos.y = y;

  // 系统开了「减少动态效果」就不做过渡，直接贴边 —— 和变身动画的处理保持一致
  const reduceMotion =
    typeof matchMedia === 'function' &&
    matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (!reduceMotion && pet && pet.classList) {
    pet.classList.add('snapping');
    // 气泡也跟着一起滑（否则球在飞、气泡瞬移，看起来像两个东西）
    if (bubble && bubble.classList) bubble.classList.add('snapping');
    applyTransform();
    if (state.bubbleOpen) positionBubble();
    if (typeof setTimeout === 'function') {
      setTimeout(() => {
        pet.classList.remove('snapping');
        if (bubble && bubble.classList) bubble.classList.remove('snapping');
      }, SNAP_MS + 40);
    }
  } else {
    applyTransform();
    if (state.bubbleOpen) positionBubble();
  }
}

function movePetTo(clientX, clientY) {
  const { w, h } = state.box;
  const maxX = Math.max(0, state.bounds.width - w);
  const maxY = Math.max(0, state.bounds.height - h);

  // 边界限制：球体不能被拖出可视区域
  state.pos.x = clamp(clientX - press.offsetX, 0, maxX);
  state.pos.y = clamp(clientY - press.offsetY, 0, maxY);

  applyTransform();
}

/** 清掉「按住」的临时状态（但不碰气泡的开关状态） */
function resetPress() {
  press.active = false;
  press.moved = false;

  if (state.dragging) {
    state.dragging = false;
    pet.classList.remove('dragging');
    document.body.classList.remove('dragging');
  }
}

/** 中断进行中的交互（窗口失焦、指针飞出窗口时用） */
function cancelInteraction() {
  resetPress();
}

// =============================================================================
// Phase 3：API key 存取 / 设置界面 / DeepSeek 请求 / 消息渲染
// =============================================================================

// -----------------------------------------------------------------------------
// 存储助手
// 带 typeof 守卫的原因：Node 的测试环境（node:vm + mock DOM）里没有 localStorage，
// 直接访问会抛 ReferenceError，把整个脚本带崩。
// 写入统一返回 boolean，让上层能给用户一句诚实的反馈，而不是「以为存上了」。
// -----------------------------------------------------------------------------
function hasLocalStorage() {
  try {
    return typeof localStorage !== 'undefined' && localStorage !== null;
  } catch (err) {
    return false;
  }
}

// -----------------------------------------------------------------------------
// Phase 3.12：本地记忆（chat_history）与好感度（favor）
//
// 设计取舍：
//   ① 记忆只存 { role, content }，不存时间戳/模型名 —— 发给 API 时原样能用；
//   ② 写入前一律过 normalize，坏数据（手改 storage、旧版本残留）直接丢掉，
//      绝不让一条脏记录把整轮请求搞挂；
//   ③ 读失败 = 空记忆，不抛错。记忆丢了不影响聊天，崩了才致命。
// -----------------------------------------------------------------------------
function normalizeHistoryEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const role = entry.role === 'user' || entry.role === 'assistant' ? entry.role : '';
  if (!role) return null;
  const content = typeof entry.content === 'string' ? entry.content.trim() : '';
  if (!content) return null;
  return { role, content };
}

/** 从 localStorage 读记忆；任何异常都退化成空数组 */
function readHistory() {
  if (!hasLocalStorage()) return [];
  let raw = null;
  try {
    raw = JSON.parse(localStorage.getItem(HISTORY_STORAGE_KEY) || '[]');
  } catch (err) {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeHistoryEntry).filter(Boolean).slice(-HISTORY_STORE_LIMIT);
}

/** 写记忆；返回是否真的落盘（localStorage 不可用时为 false，但内存里照常用） */
function writeHistory(list) {
  if (!hasLocalStorage()) return false;
  const clean = (Array.isArray(list) ? list : [])
    .map(normalizeHistoryEntry)
    .filter(Boolean)
    .slice(-HISTORY_STORE_LIMIT);
  try {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(clean));
    return true;
  } catch (err) {
    return false;
  }
}

function clampFavor(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return FAVOR_DEFAULT;
  return Math.min(FAVOR_MAX, Math.max(FAVOR_MIN, n));
}

function readFavor() {
  if (!hasLocalStorage()) return FAVOR_DEFAULT;
  let raw = null;
  try {
    raw = localStorage.getItem(FAVOR_STORAGE_KEY);
  } catch (err) {
    return FAVOR_DEFAULT;
  }
  if (raw === null || raw === '') return FAVOR_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return FAVOR_DEFAULT;
  return clampFavor(n);
}

function writeFavor(value) {
  const next = clampFavor(value);
  if (!hasLocalStorage()) return false;
  try {
    localStorage.setItem(FAVOR_STORAGE_KEY, String(next));
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Phase 3.13：好感度分档。
 * 分界按需求：<30 / 30–59 / 60–84 / ≥85。文案里的语气要求由需求给定，别随手改。
 */
function favorTier(favor) {
  const f = clampFavor(favor);
  if (f < 30) {
    return {
      key: 'irritated',
      name: '极度烦躁',
      mood: '对主人极其不耐烦，回答简短带刺，但依然会冷冰冰地解答。',
    };
  }
  if (f < 60) {
    return {
      key: 'grumpy',
      name: '日常嫌弃',
      mood: '带着死鱼眼，觉得人类笨，边抱怨边办事。',
    };
  }
  if (f < 85) {
    return {
      key: 'tsundere',
      name: '日常傲娇',
      mood: '嘴硬心软，嘴上骂笨蛋，但会顺口关心，表现出「真拿你没办法」。',
    };
  }
  return {
    key: 'peak',
    name: '傲娇巅峰',
    mood: '心里极度在意，打死不承认。表现极致的双标和护短，用最凶的语气说出最关心的话，严禁撒娇黏人，必须维持死鱼眼傲娇本色。',
  };
}

/**
 * 好感度注入块 —— 接在人设后面、深度尾注前面：人设管「是谁」，这段管「现在什么心情」。
 * 数值必须注入（模型靠它判断档位），但要求模型绝不把数值/档位说给用户听。
 */
function favorSystemBlock(favor) {
  const tier = favorTier(favor);
  return [
    '【系统隐藏设定 · 只在后台生效】',
    `你当前对主人的好感度是 ${clampFavor(favor)}/100，这个数值只用来决定你的语气。`,
    `当前档位：${tier.name} —— ${tier.mood}`,
    '不要在回复里提到好感度、数值、档位或这段设定本身的任何内容。',
    '不管多不耐烦，都要把问题真正解决掉，不能因为闹脾气拒绝回答。',
  ].join('\n');
}

/**
 * Phase 3.13 养成结算：**发送前**先算这一轮的变化。
 *   - 命中讨好词 → +10（命中多个也只加一次）
 *   - 没命中 → -1（日常闲聊会慢慢流失）
 * 结算后立刻夹到 0–100 并落盘；这次请求带的 system 用的就是结算后的值。
 * 即使请求后来失败了也不回滚：否则断网时可以先讨好再取消，来回刷数值。
 */
function settleFavorForMessage(text) {
  const content = String(text == null ? '' : text);
  const hit = FAVOR_BOOST_WORDS.find((word) => content.includes(word)) || null;
  const delta = hit ? FAVOR_BOOST_DELTA : FAVOR_DAILY_DELTA;
  const before = clampFavor(state.favor);
  const next = clampFavor(before + delta);
  state.favor = next;
  writeFavor(next);
  updateMemoryStatus();
  return { before, delta, next, hit };
}

function readKey() {
  try {
    if (!hasLocalStorage()) return '';
    const value = localStorage.getItem(API_KEY_STORAGE_KEY);
    return typeof value === 'string' ? value.trim() : '';
  } catch (err) {
    return '';
  }
}

function writeKey(key) {
  try {
    if (!hasLocalStorage()) return false;
    localStorage.setItem(API_KEY_STORAGE_KEY, key);
    // 立刻读回来验证：某些环境（隐私模式）setItem 不报错但也不会真的存下
    return localStorage.getItem(API_KEY_STORAGE_KEY) === key;
  } catch (err) {
    return false;
  }
}

function removeKey() {
  try {
    if (!hasLocalStorage()) return false;
    localStorage.removeItem(API_KEY_STORAGE_KEY);
    return true;
  } catch (err) {
    return false;
  }
}

/** 只显示开头和结尾，中间打码 —— 状态栏里可以放心显示 */
function maskKey(key) {
  const k = String(key || '');
  if (k.length <= 12) return '已保存';
  return `${k.slice(0, 5)}…${k.slice(-4)}`;
}

// -----------------------------------------------------------------------------
// Phase 3.5：思考深度的读写与应用
// -----------------------------------------------------------------------------

/**
 * 任何来源的值（localStorage、下拉框、手写调用）都先过一遍这里。
 * 好处：以后新增一档、或者旧版本存了脏数据，都不会让桌宠变成「没有立绘」。
 */
function normalizeDepth(value) {
  const v = String(value == null ? '' : value)
    .trim()
    .toLowerCase();
  return Object.prototype.hasOwnProperty.call(DEPTHS, v) ? v : DEFAULT_DEPTH;
}

function readDepth() {
  try {
    if (!hasLocalStorage()) return DEFAULT_DEPTH;
    return normalizeDepth(localStorage.getItem(DEPTH_STORAGE_KEY));
  } catch (err) {
    return DEFAULT_DEPTH;
  }
}

function writeDepth(depth) {
  const value = normalizeDepth(depth);
  try {
    if (!hasLocalStorage()) return false;
    localStorage.setItem(DEPTH_STORAGE_KEY, value);
    // 和 writeKey 一样：写进去再读回来，别「以为记住了」
    return localStorage.getItem(DEPTH_STORAGE_KEY) === value;
  } catch (err) {
    return false;
  }
}

/**
 * 按窗口大小给画框封顶。
 * 小屏（或者用户把窗口拖小了）时不让九头身顶到屏幕外，
 * 但也不无限压缩 —— 下限 120px，再小就看不清了。
 */
function depthBox(depth) {
  const d = DEPTHS[normalizeDepth(depth)];
  const maxW = Math.max(120, Math.round(state.bounds.width * BOX_VIEWPORT_LIMIT.w));
  const maxH = Math.max(120, Math.round(state.bounds.height * BOX_VIEWPORT_LIMIT.h));
  return { w: Math.min(d.w, maxW), h: Math.min(d.h, maxH) };
}

/** 把画框尺寸写进 CSS 变量（#pet 的 width/height 都读这两个值） */
function setBoxVars(box) {
  try {
    const root = document.documentElement;
    if (!root || !root.style || typeof root.style.setProperty !== 'function') return;
    root.style.setProperty('--pet-w', `${box.w}px`);
    root.style.setProperty('--pet-h', `${box.h}px`);
    // 气泡尾巴要对准角色中线：气泡右边缘与角色右边缘对齐，
    // 所以尾巴中心到右边缘 = 画框宽/2 - 尾巴半径（13px）。
    // 不跟着画框改的话，换到 210 宽的九头身后尾巴会偏 24px，一眼就能看出「没指对」。
    const tail = Math.max(18, Math.round(box.w / 2 - 13));
    root.style.setProperty('--tail-x', `${tail}px`);
  } catch (err) {
    /* 拿不到根样式就算了：CSS 里的兜底值还是 192 方框，不至于瘫掉 */
  }
}

/** 模型名的短写法：状态行只有 270px 宽，写全名会折两行 */
function shortModelName(model) {
  return String(model || '').replace(/^deepseek-/, '') || 'chat';
}

/**
 * 状态行文案。
 * 除了「长得不一样」，这里必须把「请求会怎么变」也写出来 ——
 * 否则用户没法判断这个下拉框到底是在换皮还是在换脑子。
 */
function defaultDepthText() {
  const d = DEPTHS[state.depth];
  const model = shortModelName(d.model);
  const head = `当前：${d.label} · ${model} · ${state.box.w}×${state.box.h}`;
  // 第二行单独放「会不会展示推理」：挤在第一行会折成「显示思 / 考过程」这种断词
  return d.showReasoning ? `${head}\n会展示推理过程（默认折叠）` : head;
}

function showDepthStatus(text, kind) {
  if (!depthStatus) return;
  depthStatus.textContent = text;
  if (kind) {
    depthStatus.dataset.kind = kind;
  } else {
    delete depthStatus.dataset.kind;
  }
}

/** 让下拉框和状态行跟上 state.depth（启动、换档、兜底恢复都要调） */
function syncDepthControls() {
  if (depthSelect) depthSelect.value = state.depth;
  showDepthStatus(defaultDepthText());
}

/**
 * 应用某一档深度：换图 → 换画框 → 重摆位置 → 重排气泡 → 同步界面。
 *
 * 为什么换图只改 src 而保留类名：
 *   「思考中」是 .pet-sprite.thinking 这个类名 + CSS 动画。换 src 不碰类名，
 *   所以正在思考时换档，动画不会中断（只是换了个角色在摇）。
 *
 * @param {string} depth  'low' | 'high' | 'max'（脏值会被 normalize）
 * @param {{persist?: boolean}} [options] persist=true 时同时写入 localStorage
 */
/**
 * 变身动画的时长（Phase 3.8 起放慢，改成「旧图单独退场 → 新图淡入」）。
 * 两段各自完整播完，中间只留一帧空档：
 *   · 退场 380ms：旧立绘淡出 + 轻轻上浮（重心离开画面，而不是原地缩小）
 *   · 入场 460ms：新立绘淡入 + 从下方 10px 归位
 * 总计约 0.84s —— 这是「变身」该有的呼吸，短于它就会重新变成网页换图。
 */
const MORPH_OUT_MS = 380;
const MORPH_IN_MS = 460;
/** 预解码最多等这么久；等不到也照样换图（宁可闪一下，也别卡住不换） */
const MORPH_DECODE_CAP_MS = 260;

/** 降低动效 / 启动阶段 / 没有 WAAPI：都退回「直接换图」 */
function canMorphAnimate() {
  if (state.booting) return false;
  if (!petCore || typeof petCore.animate !== 'function') return false;
  try {
    if (
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      return false;
    }
  } catch (err) {
    return true; // matchMedia 出错不该让换图卡住
  }
  return true;
}

/**
 * 预解码下一张图。
 * 不预解码的话，src 一换、解码还没完成，会先露出一个空框（一闪），
 * 然后新角色才「啪」地出现 —— 淡入动画就白做了。
 */
function preloadSprite(src) {
  if (typeof Image !== 'function') return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    try {
      const img = new Image();
      img.onload = finish;
      img.onerror = finish;
      img.src = src;
      if (typeof img.decode === 'function') {
        img.decode().then(finish).catch(finish);
      }
      setTimeout(finish, MORPH_DECODE_CAP_MS);
    } catch (err) {
      finish();
    }
  });
}

/** 取消正在进行的变身（连点切换时用）：cancel 会把元素恢复到基准样式 */
function cancelMorph() {
  state.morphSeq += 1;
  if (state.morphAnim && typeof state.morphAnim.cancel === 'function') {
    try {
      state.morphAnim.cancel();
    } catch (err) {
      /* 已经结束的动画再 cancel 会抛，忽略即可 */
    }
  }
  state.morphAnim = null;
  if (document.body && document.body.classList) {
    document.body.classList.remove('transforming');
  }
}

/**
 * 等动画结束 —— 但**不把正确性押在动画上**。
 * 窗口被遮挡/最小化时 Chromium 会暂停渲染帧，WAAPI 的 finished 可能一直不 resolve。
 * 那种情况下宁可少一段动画，也不能把立绘卡在「收起后不出现」。
 * 超时兜底之后由调用方 cancel 掉未完成的动画，让元素回到基准样式。
 */
function settleAnimation(anim, durationMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    if (anim && anim.finished && typeof anim.finished.then === 'function') {
      anim.finished.then(finish).catch(finish);
    } else {
      finish();
    }
    setTimeout(finish, durationMs + 160);
  });
}

/**
 * 变身动画本体（Phase 3.8：旧图单独退场 → 新图淡入）：
 *   ① 旧立绘淡出、轻轻上浮（380ms）—— 让原来的形态「走掉」
 *   ② 完全看不见时换图、换画框、重摆位置（只占一帧，不留空窗）
 *   ③ 新立绘从下方 10px 淡入归位（460ms）—— 新的形态「到场」
 * 不在两张图重叠时交叉淡入：两档画风差得远（半身 / Q 版 / 九头身），
 * 重叠会出现两张脸互相穿透的鬼影。让它们一前一后、各自完整地进出，
 * 读起来才是一个干净的变身，而不是两个图层在打架。
 */
async function runMorph(nextSrc, onSwap) {
  cancelMorph();
  const seq = state.morphSeq;
  const alive = () => seq === state.morphSeq;

  if (document.body && document.body.classList) {
    document.body.classList.add('transforming');
  }

  const out = petCore.animate(
    [
      { opacity: 1, transform: 'translateY(0) scale(1)' },
      { opacity: 0, transform: 'translateY(-8px) scale(0.97)' },
    ],
    {
      duration: MORPH_OUT_MS,
      // 淡出用 ease-in：起步慢、末尾快，像主动「离开」
      easing: 'cubic-bezier(0.4, 0, 0.75, 0.9)',
      fill: 'forwards',
    }
  );
  state.morphAnim = out;

  // 收起来的同一时间就开始解码下一张图，不额外增加等待
  await Promise.all([settleAnimation(out, MORPH_OUT_MS), preloadSprite(nextSrc)]);
  if (!alive()) return;
  // ⚠️ 换图必须发生在 out 的 fill:forwards（opacity 0）还压着的时候。
  //    若先 cancel 再换 src，旧图会以不透明状态闪一帧。
  if (petSprite) petSprite.src = nextSrc;
  if (typeof onSwap === 'function') onSwap();

  const back = petCore.animate(
    [
      { opacity: 0, transform: 'translateY(10px) scale(0.985)' },
      { opacity: 0.55, transform: 'translateY(5px) scale(0.994)', offset: 0.35 },
      { opacity: 1, transform: 'translateY(0) scale(1)' },
    ],
    {
      duration: MORPH_IN_MS,
      // 淡入用 ease-out：到得干脆，末尾不拖泥带水
      easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
    }
  );
  state.morphAnim = back;
  // back 的起始帧同样是透明的，此时撤销 out 不会露出任何东西
  try {
    out.cancel();
  } catch (err) {
    /* 已经播完的动画再 cancel 会抛，忽略 */
  }
  await settleAnimation(back, MORPH_IN_MS);
  if (!alive()) return;
  try {
    back.cancel();
  } catch (err) {
    /* 同上 */
  }

  state.morphAnim = null;
  if (document.body && document.body.classList) {
    document.body.classList.remove('transforming');
  }
}

function applyDepth(depth, options) {
  const opts = options || {};
  const next = normalizeDepth(depth);
  const changed = next !== state.depth;
  const prevBox = { w: state.box.w, h: state.box.h };

  state.depth = next;
  // 留给调试和自动化测试看：<img data-depth="max">
  if (petSprite && petSprite.dataset) petSprite.dataset.depth = next;

  /**
   * 换画框 + 保脚底中点 + 重排气泡 + 重算穿透区。
   * 单独抽出来是因为「变身动画」要把它推迟到暗场那一刻再执行：
   * 否则画框先变大、图还是旧的，会看到旧角色被拉变形。
   */
  const applyBox = () => {
    state.box = depthBox(next);
    setBoxVars(state.box);

    const anchorX = state.pos.x + prevBox.w / 2;
    const anchorY = state.pos.y + prevBox.h;
    state.pos.x = clamp(
      anchorX - state.box.w / 2,
      0,
      Math.max(0, state.bounds.width - state.box.w)
    );
    state.pos.y = clamp(
      anchorY - state.box.h,
      0,
      Math.max(0, state.bounds.height - state.box.h)
    );
    applyTransform();

    if (state.bubbleOpen) {
      measureBubble();
      positionBubble();
    }
    refreshIgnore();
  };

  /** 状态行文案：档位 + 真实模型 + 画框尺寸（说人话，不暴露参数名） */
  const showApplied = () => {
    const cfg = DEPTHS[next];
    const head = `${cfg.label} · ${shortModelName(cfg.model)} · ${state.box.w}×${state.box.h}`;
    showDepthStatus(
      cfg.showReasoning ? `${head}\n已生效并记住 · 会展示推理过程` : `${head}\n已生效并记住`,
      'ok'
    );
  };

  /** 界面同步 + 可选持久化（动画路径下等换图之后才调） */
  const commit = () => {
    syncDepthControls();
    if (!opts.persist) return;
    if (writeDepth(next)) {
      showApplied();
    } else {
      // 存不进去也要让人继续用 —— 只是下次启动会回到默认档
      showDepthStatus('换了，但这台机器存不住设置（localStorage 不可用），下次启动会回到默认档。', 'warn');
    }
  };

  // 同档重复调用：不换图、不播动画，但画框和状态仍对齐一次（幂等）
  if (!changed) {
    applyBox();
    commit();
    return state.depth;
  }

  if (canMorphAnimate()) {
    // 先记下来：用户切完可能立刻退出，不能等 0.5s 动画结束才写 localStorage
    if (opts.persist) writeDepth(next);
    void runMorph(DEPTHS[next].src, () => {
      applyBox();
      // 动画期间已经写过盘，这里只更新界面：
      // 状态行等新立绘「亮相」那一刻再变，避免文字先于画面上新。
      syncDepthControls();
      if (opts.persist) showApplied();
    });
  } else {
    if (petSprite) petSprite.src = DEPTHS[next].src;
    applyBox();
    commit();
  }

  return state.depth;
}

/** 读一下页面真正生效的 CSP connect-src，自检日志用 */
function readCspConnectSrc() {
  try {
    if (typeof document.querySelector !== 'function') return '(无法读取)';
    const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
    if (!meta || typeof meta.getAttribute !== 'function') return '(未找到 CSP meta)';
    const found = String(meta.getAttribute('content') || '').match(/connect-src([^;]*)/i);
    return found ? found[1].trim() : '(未声明 connect-src)';
  } catch (err) {
    return '(读取失败)';
  }
}

// -----------------------------------------------------------------------------
// 输出安全：先整体转义，再做「白名单式」的 Markdown 替换
//
// 顺序不能反！模型输出是不可信内容，直接把原始文本拼进 innerHTML 等于开后门。
// 这里的做法是：
//   ① 先把 & < > " ' 全部转义 —— 任何标签、属性都失去了「标签」的身份；
//   ② 再只针对我们认识的几种语法做替换，替换出来的标签由我们自己写。
// 所以模型即使输出 <img onerror=...> 或 <script>，也只会变成一坨可见的文字。
// -----------------------------------------------------------------------------
function escapeHtml(input) {
  return String(input == null ? '' : input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 行内语法：行内代码 / 粗体 / 斜体 / 链接 */
function inlineMarkdown(escaped) {
  let s = escaped;

  // ① 行内代码最先处理，并临时「藏」起来，
  //    这样 `a ** b` 里的 ** 不会被后面的粗体规则吃掉。
  const stash = [];
  s = s.replace(/`([^`\n]+)`/g, (match, code) => {
    stash.push(`<code class="md-code">${code}</code>`);
    return `\u0000${stash.length - 1}\u0000`;
  });

  // ② 粗体要排在斜体前面，否则 **x** 会被斜体规则先咬一口
  s = s.replace(/\*\*([^\n]+?)\*\*/g, '<strong>$1</strong>');

  // ③ 斜体：左右都要排除 *，避免把 ** 的残留当成斜体
  s = s.replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>');

  // ④ 链接渲染成「文字 + 灰色 URL」的纯展示，不做成可点击的 <a>。
  //    原因：这是常驻桌面的透明小窗，跳浏览器会弹出一个挡住整块桌面的窗口，
  //    体验很糟，也容易让人以为程序失控。用户想访问可以手动复制。
  s = s.replace(
    /\[([^\]\n]+)\]\(([^)\s]+)\)/g,
    '<span class="bubble-link">$1</span><span class="md-url">$2</span>'
  );

  // ⑤ 把藏起来的行内代码放回去
  s = s.replace(/\u0000(\d+)\u0000/g, (match, i) => stash[Number(i)] || '');

  return s;
}

/**
 * 极简 Markdown 渲染（够用就好，不引第三方库 —— CSP 也禁止远程脚本）。
 * 支持：围栏代码块、# 标题、- / 1. 列表、> 引用、--- 分隔线、粗体、斜体、
 *       行内代码、链接、段落与换行。
 */
function renderMarkdown(source) {
  const text = escapeHtml(source).replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const out = [];

  let inCode = false;
  let listTag = null; // 'ul' | 'ol'
  let para = [];

  const flushPara = () => {
    if (!para.length) return;
    out.push(`<p class="md-p">${inlineMarkdown(para.join('<br>'))}</p>`);
    para = [];
  };
  const closeList = () => {
    if (!listTag) return;
    out.push(`</${listTag}>`);
    listTag = null;
  };

  for (const line of lines) {
    // 围栏代码块：``` 或 ```js 都认
    if (/^\s*```/.test(line)) {
      if (inCode) {
        out.push('</code></pre>');
        inCode = false;
      } else {
        flushPara();
        closeList();
        out.push('<pre class="md-pre"><code>');
        inCode = true;
      }
      continue;
    }

    // 代码块内部原样保留（包括空行）
    if (inCode) {
      out.push(`${line}\n`);
      continue;
    }

    if (!line.trim()) {
      flushPara();
      closeList();
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushPara();
      closeList();
      const level = heading[1].length;
      out.push(`<p class="md-h md-h${level}">${inlineMarkdown(heading[2])}</p>`);
      continue;
    }

    if (/^\s*(?:-{3,}|\*{3,})\s*$/.test(line)) {
      flushPara();
      closeList();
      out.push('<hr class="md-hr">');
      continue;
    }

    // 引用：> 已经被转义成 &gt;
    const quote = line.match(/^\s*&gt;\s?(.*)$/);
    if (quote) {
      flushPara();
      closeList();
      out.push(`<p class="md-quote">${inlineMarkdown(quote[1])}</p>`);
      continue;
    }

    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || numbered) {
      flushPara();
      const want = bullet ? 'ul' : 'ol';
      if (listTag !== want) {
        closeList();
        out.push(`<${want} class="md-list">`);
        listTag = want;
      }
      out.push(`<li class="md-li">${inlineMarkdown((bullet || numbered)[1])}</li>`);
      continue;
    }

    para.push(line);
  }

  if (inCode) out.push('</code></pre>'); // 模型把 ``` 忘了收尾时兜底
  flushPara();
  closeList();

  return out.join('');
}

// -----------------------------------------------------------------------------
// 界面更新
// -----------------------------------------------------------------------------

/** 消息变化后重新量尺寸 + 重新摆位置（不这么做，长出来的部分会点不动） */
function relayoutBubble() {
  measureBubble();
  if (state.bubbleOpen) positionBubble();
}

/**
 * 往消息列表里加一条。
 * role: 'user' | 'assistant' | 'error' | 'notice'
 * 用户输入和错误文案一律走 textContent，只有模型回答才走 Markdown 渲染。
 */
function appendMessage(role, text, options) {
  if (!bubbleLog) return null;
  const opts = options || {};
  const raw = String(text == null ? '' : text);

  const el = document.createElement('div');
  el.className = `msg msg--${role}`;

  const body = document.createElement('div');
  body.className = 'msg-body';

  if (role === 'assistant' && opts.plain !== true) {
    body.innerHTML = renderMarkdown(raw);
  } else {
    body.textContent = raw;
  }
  el.appendChild(body);

  // 只有回答才需要「复制」按钮：错误提示和用户自己的话没有复制的意义
  if (role === 'assistant' && opts.copy !== false) {
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'msg-copy';
    copyBtn.textContent = '复制';
    copyBtn.title = '复制这条回答（原始 Markdown）';
    copyBtn.addEventListener('click', () => onCopy(copyBtn, raw));
    el.appendChild(copyBtn);
  }

  bubbleLog.appendChild(el);

  // 自动滚到底部，让用户看到最新一条
  if (typeof bubbleLog.scrollHeight === 'number') {
    bubbleLog.scrollTop = bubbleLog.scrollHeight;
  }

  relayoutBubble();
  return el;
}

/**
 * 显示「思考过程」（只有 reasoner 会返回 reasoning_content）。
 * 用 <details> 而不是直接铺开：推理过程动辄上千字，铺开会把回答挤到屏幕外。
 * 内容一律 textContent —— 这是模型吐出来的文本，不是可信 HTML。
 */
function appendReasoning(text) {
  if (!bubbleLog) return null;
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return null;

  const wrap = document.createElement('details');
  wrap.className = 'msg-think';

  const sum = document.createElement('summary');
  sum.textContent = `思考过程 · ${raw.length} 字（点开看）`;
  sum.title = '这是模型在给出答案前自己的推演，不是最终回答';

  const body = document.createElement('div');
  body.className = 'msg-think-body';
  body.textContent = raw;

  wrap.appendChild(sum);
  wrap.appendChild(body);

  // 展开 / 收起会改变气泡高度：不重排的话，多出来的部分点不动。
  // 展开时把这块顶到可视区顶部 —— 否则「点了展开却看不到推理内容」，
  // 因为消息区是固定高度内部滚动的，新长出来的部分在视口之外。
  wrap.addEventListener('toggle', () => {
    if (wrap.open && typeof bubbleLog.scrollTop === 'number') {
      // 用 rect 差值而不是 offsetTop：offsetTop 是相对 offsetParent 的，
      // 消息区不是定位元素时会被多算一截（实测正好差一个标题的高度）。
      const delta =
        wrap.getBoundingClientRect().top - bubbleLog.getBoundingClientRect().top;
      bubbleLog.scrollTop = Math.max(0, bubbleLog.scrollTop + delta - 6);
    }
    relayoutBubble();
  });

  bubbleLog.appendChild(wrap);
  if (typeof bubbleLog.scrollHeight === 'number') {
    bubbleLog.scrollTop = bubbleLog.scrollHeight;
  }
  relayoutBubble();
  return wrap;
}

/** 开启 / 关闭「正在思考」的动画（不动 <img> 的 src，只加类名） */
function setThinking(on) {
  state.thinking = Boolean(on);
  if (petSprite) petSprite.classList.toggle('thinking', state.thinking);
  document.body.classList.toggle('thinking', state.thinking);
}

/** 输入框下面那行小字：常态是操作提示，出错时变成红字 */
function setTag(text, kind) {
  if (!bubbleTag) return;
  bubbleTag.textContent = text;
  if (kind) {
    bubbleTag.dataset.kind = kind;
  } else {
    delete bubbleTag.dataset.kind;
  }
}

function showKeyStatus(text, kind) {
  if (!keyStatus) return;
  keyStatus.textContent = text;
  if (kind) {
    keyStatus.dataset.kind = kind;
  } else {
    delete keyStatus.dataset.kind;
  }
}

/** 有 key 时显示打码后的确认信息，没有时给出引导 */
function refreshKeyStatus() {
  if (!keyStatus) return;
  const key = readKey();
  if (key) {
    showKeyStatus(`已经存好饭卡了（${maskKey(key)}），点「保存」可以换一张。`, 'ok');
  } else {
    showKeyStatus('还没有饭卡，先填一个才能聊天～', 'empty');
  }
}

/** 发送按钮：没内容或正在发送时禁用 */
function updateSendState() {
  if (!bubbleSend) return;
  const hasText = bubbleInput ? String(bubbleInput.value || '').trim().length > 0 : false;
  bubbleSend.disabled = state.sending || !hasText;
}

/** 输入框跟着内容长高（最多 160px，再多就内部滚动） */
function autoGrowInput() {
  if (!bubbleInput || !bubbleInput.style) return;
  const max = 160;
  try {
    bubbleInput.style.height = 'auto';
    const next = Number(bubbleInput.scrollHeight) || 0;
    if (next > 0) bubbleInput.style.height = `${Math.min(next, max)}px`;
  } catch (err) {
    /* 量不出来就算了，靠 CSS 的 min-height 兜着 */
  }
}

function focusPanel() {
  if (!state.bubbleOpen) return;
  if (state.panel === 'settings') {
    if (keyInput) keyInput.focus();
  } else if (state.panel === 'wallet') {
    // 钱包视图没有输入框：把焦点从聊天框上摘掉，顺便收起输入法
    if (bubbleInput && document.activeElement === bubbleInput) bubbleInput.blur();
    setImeFriendly(false);
  } else if (bubbleInput) {
    bubbleInput.focus();
  }
}

/** 切换「聊天 / 设置 / 钱包」三个视图 */
function setPanel(name) {
  state.panel = name === 'settings' ? 'settings' : name === 'wallet' ? 'wallet' : 'chat';

  if (viewChat) viewChat.hidden = state.panel !== 'chat';
  if (viewSettings) viewSettings.hidden = state.panel !== 'settings';
  if (viewWallet) viewWallet.hidden = state.panel !== 'wallet';
  if (bubbleTitle) bubbleTitle.textContent = state.panel === 'settings' ? '设置' : '吃白饭的大肥鱼';

  if (state.panel === 'settings') {
    refreshKeyStatus();
    updateMemoryStatus();
    // 每次进设置页都把下拉框对齐到「真正生效的档位」——
    // 万一上次存盘失败、或者有人手动改了 localStorage，这里能自动纠正显示
    syncDepthControls();
  } else if (state.panel === 'chat') {
    setTag(state.sending ? '正在思考…' : TAG_HINT, state.sending ? 'busy' : null);
  }

  relayoutBubble(); // 三个视图高度不同，必须重新量、重新摆
  focusPanel();
}

/**
 * 从钱包视图静默退回聊天视图 —— 只改显示，不量不摆。
 * 用在 closeBubble 里：气泡已经藏起来了，这时候再 measure 只会拿到 0。
 */
function resetWalletView() {
  if (state.panel !== 'wallet') return;
  state.panel = 'chat';
  if (viewChat) viewChat.hidden = false;
  if (viewSettings) viewSettings.hidden = true;
  if (viewWallet) viewWallet.hidden = true;
  if (bubbleTitle) bubbleTitle.textContent = '吃白饭的大肥鱼';
}

// -----------------------------------------------------------------------------
// 设置界面的动作
// -----------------------------------------------------------------------------

/**
 * 刷新记忆行。
 * ⚠️ 只显示「记忆 N 条」—— 好感度是后台数值（Phase 3.13），
 *    界面上不出现数字、不出现进度条，也不提示这个系统的存在。
 */
function updateMemoryStatus() {
  if (!memoryStatus) return;
  memoryStatus.textContent = `记忆 ${state.history.length} 条`;
}

/**
 * 清空聊天记忆。
 * 只清 chat_history，**不动 favor**：好感度是长期关系，不是聊天记录的一部分。
 * 视觉上把气泡里的旧消息也一起清掉，否则「记忆清了但屏幕还挂着」很割裂。
 */
function onClearMemory() {
  state.history = [];
  writeHistory([]);
  if (hasLocalStorage()) {
    try {
      localStorage.removeItem(HISTORY_STORAGE_KEY);
    } catch (err) {
      /* 清不掉就算了，内存里已经空了 */
    }
  }

  if (bubbleLog) bubbleLog.textContent = '';
  updateMemoryStatus();
  appendMessage('notice', '记忆清空了，重新认识一下？');
  relayoutBubble();
  setTag('聊天记忆已清空', 'ok');
}

function onSaveKey() {
  if (!keyInput) return;
  const value = String(keyInput.value || '').trim();

  if (!value) {
    showKeyStatus('输入框还是空的，先把 key 粘进来再点保存～', 'warn');
    return;
  }

  // 只是「像不像」，不做严格校验：key 的格式以后可能变，误报比漏报更烦人
  if (!/^sk-[A-Za-z0-9_-]{8,}$/.test(value)) {
    showKeyStatus('这串看起来不太像 key（一般以 sk- 开头），再确认一下？', 'warn');
    return;
  }

  if (!writeKey(value)) {
    showKeyStatus('存不进去=（ 这台机器的 localStorage 好像不可用。', 'error');
    return;
  }

  keyInput.value = '';
  refreshKeyStatus();
  setPanel('chat');
  setTag('饭卡存好啦～现在可以聊天了', 'ok');
}

function onClearKey() {
  const had = Boolean(readKey());
  removeKey();
  if (keyInput) keyInput.value = '';
  refreshKeyStatus();
  showKeyStatus(had ? '饭卡已经拿走了～现在聊天会提示你先去填。' : '本来就没有存饭卡。', 'warn');
}

// -----------------------------------------------------------------------------
// ESC：设置页退回聊天页，聊天页才收起气泡
// -----------------------------------------------------------------------------
function handleEscape(event) {
  if (!event || event.key !== 'Escape' || !state.bubbleOpen) return;
  event.preventDefault();
  if (state.panel === 'settings') {
    setPanel('chat');
    return;
  }
  closeBubble();
}

// -----------------------------------------------------------------------------
// DeepSeek 请求
// -----------------------------------------------------------------------------

/** 从错误响应体里尽量挖出人类能看懂的那句话 */
function extractApiMessage(rawBody) {
  const body = String(rawBody || '');
  if (!body) return '';
  try {
    const parsed = JSON.parse(body);
    const msg =
      (parsed && parsed.error && parsed.error.message) || (parsed && parsed.message) || '';
    return typeof msg === 'string' ? msg.trim().slice(0, 200) : '';
  } catch (err) {
    return body.trim().slice(0, 200);
  }
}

/** 把 HTTP 状态码翻译成人话 */
function describeHttpError(status, detail) {
  const extra = detail ? `（${detail}）` : '';
  if (status === 401 || status === 403) return BAD_KEY_MESSAGE; // ← 需求指定的原话
  if (status === 402) return `饭卡里没钱了（账户余额不足）${extra}`;
  if (status === 400) return `这条消息服务器读不懂（400）${extra}`;
  if (status === 404) return `接口地址不对（404），可能 API 变了${extra}`;
  if (status === 422) return `请求内容不合法（422）${extra}`;
  if (status === 429) return '问得太快啦，服务器让我先歇一会儿，过会儿再试～';
  if (status >= 500) return `服务器那边出问题了（${status}），不是你的锅${extra}`;
  return `请求失败了（${status}）${extra}`;
}

/**
 * 网络层异常：超时中断 vs 连不上。
 * 秒数必须跟着档位走 —— 「极致」档等 180 秒，报错却说 60 秒，用户会以为程序在骗他。
 */
function describeNetworkError(err, timeoutMs) {
  const seconds = Math.round((Number(timeoutMs) || REQUEST_TIMEOUT_MS) / 1000);
  if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
    return `等太久啦（${seconds} 秒还没回应），我先放弃了=（ 要不再试一次？`;
  }
  return '网络好像不通（连不上 api.deepseek.com），检查一下网络再试？';
}

/**
 * 按当前档位拼请求体。**思考深度真正生效的地方就是这里**：
 *   1. model      —— 轻/标准用 chat，极致用 reasoner（真的会推理）
 *   2. max_tokens —— 决定答案能有多长（reasoner 还要分给推理过程）
 *   3. temperature—— 轻量更发散、标准更收敛；reasoner 不支持，必须不发
 *   4. system 尾注 —— 用自然语言要求「答多细」，和上面的硬参数互补
 * 单独抽成函数是为了能在测试里直接断言请求体，而不是靠肉眼看网络面板。
 */
function buildPayload(text, depthKey) {
  const cfg = DEPTHS[normalizeDepth(depthKey)] || DEPTHS[DEFAULT_DEPTH];
  // 只带最近 5 轮（10 条）：更早的内容会被截断，避免请求体越长越贵、越慢。
  // state.history 里存的都是「已经成功聊过」的轮次，当前这句在最后单独追加。
  const recent = state.history.slice(-HISTORY_INJECT_LIMIT);
  const payload = {
    model: cfg.model,
    messages: [
      {
        role: 'system',
        content: `${SYSTEM_PROMPT}\n\n${favorSystemBlock(state.favor)}\n\n【本次回答的详细程度】${cfg.style}`,
      },
      ...recent,
      { role: 'user', content: text },
    ],
    stream: false,
    max_tokens: cfg.maxTokens,
  };
  // reasoner 会拒绝 temperature（400），所以只有非 null 才带上
  if (typeof cfg.temperature === 'number') payload.temperature = cfg.temperature;
  return payload;
}

/**
 * 真正发请求。
 * 返回值统一成 { ok:true, text } 或 { ok:false, status?, message }，
 * 调用方不需要 try/catch —— 所有异常都在这里被翻译成用户可读的一句话。
 */
async function requestDeepSeek(key, text) {
  if (typeof fetch !== 'function') {
    return { ok: false, message: '这个环境发不了请求（没有 fetch）。' };
  }

  // 在发请求的这一刻就把档位钉住：用户中途换档不能让「收回来的回答」
  // 和「实际用的参数」对不上（例如 reasoner 的结果被当成 chat 的结果展示）。
  const depthAtSend = state.depth;
  const cfg = DEPTHS[normalizeDepth(depthAtSend)] || DEPTHS[DEFAULT_DEPTH];
  const payload = buildPayload(text, depthAtSend);
  const timeoutMs = cfg.timeoutMs || REQUEST_TIMEOUT_MS;

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  state.abort = controller;
  if (controller) {
    state.timeoutId = setTimeout(() => {
      try {
        controller.abort();
      } catch (err) {
        /* 已经结束了，忽略 */
      }
    }, timeoutMs);
  }

  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(payload),
      signal: controller ? controller.signal : undefined,
    });
  } catch (err) {
    return { ok: false, message: describeNetworkError(err, timeoutMs) };
  }

  if (!res || res.ok !== true) {
    const status = res ? res.status : 0;
    let detail = '';
    try {
      detail = extractApiMessage(await res.text());
    } catch (err) {
      detail = '';
    }
    return { ok: false, status, message: describeHttpError(status, detail) };
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    return { ok: false, message: '返回的内容看不懂（不是合法 JSON），要不再试一次？' };
  }

  const message =
    data && data.choices && data.choices[0] ? data.choices[0].message : null;
  const content = message ? message.content : '';
  // only reasoner 才有；chat 模型这里是 undefined
  const reasoning =
    message && typeof message.reasoning_content === 'string'
      ? message.reasoning_content.trim()
      : '';

  if (typeof content !== 'string' || !content.trim()) {
    // 推理模型可能出现「想了但正文为空」，这种情况要单独解释，
    // 否则用户会以为是程序坏了。
    if (reasoning) {
      return { ok: false, message: '模型只输出了推理过程、没给出正文，再问一次试试？' };
    }
    return { ok: false, message: '模型这次没给出内容，再问一次试试？' };
  }

  return {
    ok: true,
    text: content.trim(),
    reasoning,
    model: cfg.model,
    depth: depthAtSend,
    usage: (data && data.usage) || null,
  };
}

// -----------------------------------------------------------------------------
// Phase 3.14：右键 —— 查 DeepSeek 余额
// -----------------------------------------------------------------------------

/** 110.00 + CNY → ¥110.00；不认识的币种就显示「110.00 XXX」 */
function formatBalance(amount, currency) {
  const value = String(amount == null ? '' : amount).trim();
  const code = String(currency || '').trim().toUpperCase();
  const symbol = CURRENCY_SYMBOLS[code];
  if (symbol) return `${symbol}${value}`;
  return code ? `${value} ${code}` : value;
}

/**
 * 查余额。返回 { ok:true, amount, currency } 或 { ok:false, reason:'no-key'|'error' }。
 * 所有异常都翻译成 reason，调用方只负责挑文案 —— 和 requestDeepSeek 的约定一致。
 */
async function fetchBalance() {
  const key = readKey();
  if (!key) return { ok: false, reason: 'no-key' };
  if (typeof fetch !== 'function') return { ok: false, reason: 'error' };

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timeoutId = controller
    ? setTimeout(() => {
        try {
          controller.abort();
        } catch (err) {
          /* 已经结束了，忽略 */
        }
      }, BALANCE_TIMEOUT_MS)
    : null;

  try {
    const res = await fetch(BALANCE_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
      signal: controller ? controller.signal : undefined,
    });

    if (!res || res.ok !== true) return { ok: false, reason: 'error' };

    const data = await res.json();
    // DeepSeek 的返回是 { is_available, balance_infos:[{currency,total_balance,...}] }
    // 新版也可能给顶层字段，这里两种都兼容，别因为接口小改就整块报错。
    const info = data && Array.isArray(data.balance_infos) ? data.balance_infos[0] : null;
    const amount = info && info.total_balance != null ? info.total_balance : data && data.total_balance;
    const currency =
      (info && info.currency) || (data && data.currency) || '';

    if (amount == null || amount === '') return { ok: false, reason: 'error' };
    return { ok: true, amount: String(amount), currency: String(currency) };
  } catch (err) {
    return { ok: false, reason: 'error' };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/** 把钱包视图切出来并写入文案；loading → 结果 会改变高度，所以每次都重新摆 */
function showWalletMessage(text) {
  if (walletText) walletText.textContent = text;
  if (!state.bubbleOpen) openBubble();
  setPanel('wallet');
  relayoutBubble();
}

/**
 * 右键桌宠：查余额。
 * ⚠️ 必须 preventDefault：Electron 在 macOS 上会弹系统右键菜单，盖在桌宠上很出戏。
 * ⚠️ 只拦右键：左键的拖拽 / 点击开关气泡逻辑在 onMouseDown 里，button!==0 时直接返回。
 */
async function onPetContextMenu(event) {
  event.preventDefault();
  event.stopPropagation();

  const seq = ++state.balanceSeq;
  showWalletMessage(BALANCE_LOADING_TEXT);

  const result = await fetchBalance();
  // 期间用户可能左键切回聊天、或又右键了一次：旧请求不许盖掉新状态
  if (seq !== state.balanceSeq || state.panel !== 'wallet') return;

  if (result.ok) {
    showWalletMessage(
      `（半睁死鱼眼） 本小姐的饭钱还剩 ${formatBalance(result.amount, result.currency)}。省着点用，别一会就花光了！`
    );
    return;
  }

  showWalletMessage(result.reason === 'no-key' ? BALANCE_NO_KEY_TEXT : BALANCE_ERROR_TEXT);
}

// -----------------------------------------------------------------------------
// 发送流程
// -----------------------------------------------------------------------------
async function onSend() {
  if (!bubbleInput) return;

  const text = String(bubbleInput.value || '').trim();
  if (!text) return; // 空输入不发请求
  if (state.sending) return; // 正在发送，拦住重复点击

  if (state.panel !== 'chat') setPanel('chat');

  const key = readKey();
  appendMessage('user', text);
  bubbleInput.value = '';
  autoGrowInput();

  // 没配 key：给出指定的提示，并且留在聊天页（否则提示会被设置页挡住看不见）
  if (!key) {
    appendMessage('notice', NO_KEY_MESSAGE);
    setTag('点右上角齿轮填 API key', 'error');
    updateSendState();
    return;
  }

  // Phase 3.13：先结算这一轮的好感度（讨好词 +10 / 日常 -1），再拼请求
  settleFavorForMessage(text);

  // 本次发送用的档位（中途换档不影响这一条请求）
  const sendingDepth = state.depth;
  const sendingCfg = DEPTHS[normalizeDepth(sendingDepth)] || DEPTHS[DEFAULT_DEPTH];

  state.sending = true;
  updateSendState();
  // 极致档真的会推理，等待更久 —— 提示要说实话，别让人以为卡死了
  setTag(
    sendingCfg.showReasoning ? '正在深度推理…（极致档会多想一会儿）' : '正在思考…',
    'busy'
  );
  setThinking(true);

  let result;
  try {
    result = await requestDeepSeek(key, text);
  } catch (err) {
    // 理论上不会走到这里（requestDeepSeek 自己吞了异常），但兜一层更稳妥
    result = { ok: false, message: `出了点意外=（ ${err && err.message ? err.message : ''}` };
  } finally {
    // 无论成功、失败、超时，都必须把「思考中」收回来 ——
    // 否则动画会一直转，用户以为程序卡死了。
    state.sending = false;
    state.abort = null;
    if (state.timeoutId) {
      clearTimeout(state.timeoutId);
      state.timeoutId = 0;
    }
    setThinking(false);
    updateSendState();
  }

  if (result.ok) {
    // 推理过程放在回答上面，默认折叠：想看的人点开，不想看的人不被打扰
    if (result.reasoning) appendReasoning(result.reasoning);
    appendMessage('assistant', result.text);
    // 记进历史，让下一轮能接上下文（本地最多留 20 轮，注入时只取最近 5 轮）
    state.history.push({ role: 'user', content: text });
    state.history.push({ role: 'assistant', content: result.text });
    if (state.history.length > HISTORY_STORE_LIMIT) {
      state.history.splice(0, state.history.length - HISTORY_STORE_LIMIT);
    }
    writeHistory(state.history); // 关掉程序再打开，记忆还在
    updateMemoryStatus();

    setTag(TAG_HINT);
    return;
  }

  appendMessage('error', result.message);
  setTag(
    result.status === 401 || result.status === 403 ? 'API key 有问题，点齿轮检查一下' : '出错了，改一下再试？',
    'error'
  );
}

// -----------------------------------------------------------------------------
// 一键复制（三级兜底）
// -----------------------------------------------------------------------------
async function copyToClipboard(text) {
  const value = String(text == null ? '' : text);

  // ① 主进程剪贴板（Electron 里最可靠）
  if (api && typeof api.copyText === 'function') {
    try {
      if (await api.copyText(value)) return true;
    } catch (err) {
      /* 落到下一级 */
    }
  }

  // ② 浏览器 Clipboard API（需要安全上下文，file:// 下不一定有）
  try {
    if (
      typeof navigator !== 'undefined' &&
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === 'function'
    ) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch (err) {
    /* 落到下一级 */
  }

  // ③ 老办法：临时 textarea + execCommand
  try {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = typeof document.execCommand === 'function' ? document.execCommand('copy') : false;
    document.body.removeChild(ta);
    return Boolean(ok);
  } catch (err) {
    return false;
  }
}

async function onCopy(button, text) {
  if (!button || button.dataset.busy === '1') return;
  button.dataset.busy = '1';

  const original = button.textContent || '复制';
  const ok = await copyToClipboard(text);

  button.textContent = ok ? '已复制' : '复制失败';
  button.classList.toggle('is-done', ok);

  setTimeout(() => {
    button.textContent = original;
    button.dataset.busy = '0';
    button.classList.remove('is-done');
  }, 1400);
}

// -----------------------------------------------------------------------------
// 事件绑定
// -----------------------------------------------------------------------------
function bindPhase3Events() {
  // 齿轮：在聊天 / 设置之间来回切
  if (bubbleGear) {
    bubbleGear.addEventListener('click', (event) => {
      event.preventDefault();
      setPanel(state.panel === 'settings' ? 'chat' : 'settings');
    });
  }

  if (bubbleSend) {
    bubbleSend.addEventListener('click', () => {
      onSend();
    });
  }

  if (keySave) {
    keySave.addEventListener('click', () => onSaveKey());
  }

  if (keyClear) {
    keyClear.addEventListener('click', () => onClearKey());
  }

  // Phase 3.12：清空聊天记忆（只清 chat_history，不动 favor）
  if (memoryClear) {
    memoryClear.addEventListener('click', () => onClearMemory());
  }

  // 思考深度：change 即生效 + 即写入 localStorage。
  // 为什么不等「保存」按钮：下拉框是即时预览型控件，选完看不到变化会以为坏了；
  // 而「选了但忘了点保存」就成了更难解释的 bug（下次启动又变回去）。
  // key 的保存按钮保持原样，只负责密钥。
  if (depthSelect) {
    depthSelect.addEventListener('change', () => {
      applyDepth(depthSelect.value, { persist: true });
    });
  }

  if (bubbleInput) {
    // 输入时同步按钮状态，并让输入框长高
    bubbleInput.addEventListener('input', () => {
      autoGrowInput();
      updateSendState();
    });

    // ↩ 换行；⌘/Ctrl + ↵ 发送。
    // isComposing 判断是给中文输入法用的：选字时按回车是「确认候选词」，
    // 不拦掉的话会莫名其妙把半成品发出去。
    bubbleInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.isComposing) return;
      if (event.metaKey || event.ctrlKey) {
        event.preventDefault();
        onSend();
      }
    });
  }

  if (keyInput) {
    keyInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        onSaveKey();
      }
    });
  }

  updateSendState();
}

// -----------------------------------------------------------------------------
// 启动
// -----------------------------------------------------------------------------
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
