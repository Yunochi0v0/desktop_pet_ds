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
const bubbleTabs = document.getElementById('bubble-tabs');
const bubbleTabChat = document.getElementById('bubble-tab-chat');
const bubbleTabTodo = document.getElementById('bubble-tab-todo');
const bubbleTabWeather = document.getElementById('bubble-tab-weather');
const viewChat = document.getElementById('view-chat');
const viewSettings = document.getElementById('view-settings');
const viewTodo = document.getElementById('view-todo');
const viewWeather = document.getElementById('view-weather');
// Phase 3.14：右键查余额的专用视图（只在右键时出现，不碰聊天记录和输入框）
const viewWallet = document.getElementById('view-wallet');
const walletText = document.getElementById('wallet-text');

// Phase 3.22 新增：猜拳面板（气泡的第四个视图）
const viewGame = document.getElementById('view-game');
const gameScore = document.getElementById('game-score');
const gameClose = document.getElementById('game-close');
const gameMoves = document.getElementById('game-moves');
const gameLine = document.getElementById('game-line');
const gameHands = document.getElementById('game-hands');
const gameActions = document.getElementById('game-actions');
const gameAgain = document.getElementById('game-again');
const gameQuit = document.getElementById('game-quit');
// 牌局进行中右键菜单顶部那行「先打完这局」
const petMenuNote = document.getElementById('pet-menu-note');
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

// Phase 3.21 新增：语音播报 / 剪贴板吐槽 两个下拉框 + 状态行
const speechSelect = document.getElementById('speech-select');
const speechStatus = document.getElementById('speech-status');
const clipSelect = document.getElementById('clip-select');

// Phase 3.18 新增：番茄钟倒计时胶囊 + 右键菜单
const pomoChip = document.getElementById('pomo-chip');
const pomoChipText = document.getElementById('pomo-chip-text');
const petMenu = document.getElementById('pet-menu');

// Phase 3.27 新增：天气页（#bubble 的第六个视图，不再是独立卡片）
const weatherPage = document.getElementById('weather-page');
const weatherFx = document.getElementById('weather-fx');
const weatherIcon = document.getElementById('weather-icon');
const weatherTemp = document.getElementById('weather-temp');
const weatherCond = document.getElementById('weather-cond');
const weatherDate = document.getElementById('weather-date');
const weatherBody = document.getElementById('weather-body');
const weatherSay = document.getElementById('weather-say');
const weatherUpdated = document.getElementById('weather-updated');
const weatherRefresh = document.getElementById('weather-refresh');
const weatherClose = document.getElementById('weather-close');
const petMenuWeather = document.getElementById('pet-menu-weather');

// —— Phase 3.28：地区选择 ——
const weatherLocBtn = document.getElementById('weather-loc-btn');
const weatherLocName = document.getElementById('weather-loc-name');
const weatherPlace = document.getElementById('weather-place');
const weatherLocPanel = document.getElementById('weather-loc-panel');
const weatherLocClose = document.getElementById('weather-loc-close');
const weatherLocForm = document.getElementById('weather-loc-form');
const weatherLocInput = document.getElementById('weather-loc-input');
const weatherLocSearch = document.getElementById('weather-loc-search');
const weatherLocStatus = document.getElementById('weather-loc-status');
const weatherLocResults = document.getElementById('weather-loc-results');
const weatherLocQuick = document.getElementById('weather-loc-quick');

// Phase 3.24 新增：待办视图（Phase 3.25 起并入 #bubble，不再独立悬浮）。
// 全部做判空：浏览器里单独打开 index.html / 老版本 HTML 时不至于整页崩。
const petMenuTodo = document.getElementById('pet-menu-todo');
const todoPanel = document.getElementById('todo-panel');
const todoSay = document.getElementById('todo-say');
const todoForm = document.getElementById('todo-form');
const todoInput = document.getElementById('todo-input');
const todoAdd = document.getElementById('todo-add');
const todoClose = document.getElementById('todo-close');
const todoCount = document.getElementById('todo-count');
const todoPending = document.getElementById('todo-pending');
const todoDone = document.getElementById('todo-done');
const todoPendingCount = document.getElementById('todo-pending-count');
const todoDoneCount = document.getElementById('todo-done-count');
const todoEmpty = document.getElementById('todo-empty');

// 按下后移动多少像素，才从「单击」升级成「拖拽」
const DRAG_THRESHOLD = 4;
// Phase 3.12：拖拽松手时离屏幕边缘多近就吸附过去
const SNAP_DISTANCE = 30;
// 吸附动画时长（必须与 style.css 的 #pet.snapping 一致）
const SNAP_MS = 260;

// -----------------------------------------------------------------------------
// Phase 3.18：番茄钟
//
// 渲染进程**不持有计时器**，只负责「把主进程推过来的快照画出来」。
// 原因写在 main.js：页面会被系统节流，25 分钟能拖成 30 分钟。
// 这里唯一的时间相关逻辑是「什么时候换图」—— 由 phase 决定，与剩余秒数无关，
// 所以每秒的 tick 只是改一行文本，不会碰图片、不会触发重排。
// -----------------------------------------------------------------------------
const POMO_IDLE = 'idle';
const POMO_FOCUS = 'focusing';
const POMO_REST = 'resting';

/** 专注归零时的大号对话框（需求指定台词） */
const POMO_DONE_FOCUS_LINE = '（伸懒腰） 时间到啦！笨蛋，快起来活动一下！';
/** 休息归零：需求没指定，补一句同风格的话，否则休息结束会毫无反馈 */
const POMO_DONE_REST_LINE = '（合上笔记本） 休息够了吧？该回来继续干活了。';

/** 大号对话框保持多久（到点自动缩回正常大小） */
const POMO_BIG_DIALOG_MS = 8000;
/** 小胶囊与角色头顶 / 脚下的间距 */
const POMO_CHIP_GAP = 6;
/**
 * 专注结束时「好耶」保持多久（Phase 3.23）。
 * 为什么是 3 秒：主进程在同一帧就把 phase 翻成 resting，休息表情是抱枕，
 * 立刻切过去等于「时间到」三个字还没说出来她就躺下了。3 秒够看清欢呼、
 * 也不至于让她举着手站到对话框（8 秒）结束。
 */
const POMO_CHEER_MS = 3000;

// -----------------------------------------------------------------------------
// Phase 3.21：剪贴板吐槽 + 语音播报
//
// 剪贴板那半边住在主进程（只有它读得到系统剪贴板），这里只做两件事：
//   ① 收到 clipboard:hint 之后，挑一句傲娇台词**被动**弹个气泡（不抢焦点）；
//   ② 回答落地之后，如果你开了语音，就念一遍纯文本。
//
// 为什么「被动弹」要单独一套：openBubble 会 focusWindow —— 那会让正在 VS Code
// 里打字的你瞬间丢失焦点。剪贴板吐槽是「她自己在旁边嘀咕」，不该抢键盘。
// -----------------------------------------------------------------------------

/** 语音开关：'on' / 'off'，默认 off（不打招呼就出声很吓人） */
const SPEECH_STORAGE_KEY = 'pet_speech';
/** 剪贴板吐槽开关，默认 on —— 但必须给用户一个关掉的地方（隐私） */
const CLIP_ROAST_STORAGE_KEY = 'pet_clip_roast';

/** 语速略快 + 音调偏高 = 小个子在嫌弃你；两者都别过头，否则像花栗鼠 */
const SPEECH_RATE = 1.12;
const SPEECH_PITCH = 1.28;
/** 一条回答最多念这么多字，超了只念开头（不然 30 秒后她还在念） */
const SPEECH_MAX_CHARS = 200;

/** 被动弹出的吐槽气泡自己收起的时间：够看清一句话，又不至于一直挡着桌面 */
const ROAST_VISIBLE_MS = 8000;

/**
 * 吐槽台词库。
 * 原则：像「她看到你复制的东西之后随口嫌弃一句」，不要解释技术问题 ——
 * 真正的问题你已经知道了，她要是在这儿讲课就没意思了。
 */
const ROAST_LINES = {
  error: [
    '又写 Bug 了？啧，我就知道。',
    '这报错都复制过来了，是想让我替你背锅吗？',
    '（半睁死鱼眼）这么明显的错，也要我亲口说一遍？',
    '先别慌，八成又是少了个分号。',
    '报错了就报错了，别盯着我看，看代码去。',
    '拿这种红字来烦我……行吧，放这儿，我瞅一眼。',
  ],
  code: [
    '这么长一段，你是想让我逐行批改作业吗？',
    '复制这么多，是想让我夸你勤奋？想得美。',
    '我扫了一眼，逻辑比我的头发还乱。',
    '能跑就行，别改了，改完又该炸了。',
    '唔……勉强看得下去，就当你在努力吧。',
  ],
};

// -----------------------------------------------------------------------------
// Phase 3.15：拖拽惯性（甩尾）+ 边界碰撞 Q 弹
//
// 物理模型只有两行：
//   ① 松手时把「最后两帧的位移 / 时间」当成初速度（px/ms）；
//   ② 每帧按 dt 做指数衰减，撞到边界就把该轴速度反向并乘反弹系数。
// 刻意不做质量/重力：桌宠是「在桌面上滑」而不是「抛物线飞」，加了重力反而不像。
// -----------------------------------------------------------------------------

/** 低于这个速度（px/ms ≈ 450px/s）就当成「慢慢放下」，不甩出去 */
const FLING_MIN_SPEED = 0.45;
/** 速度上限：防止一次瞬移（测试或高刷鼠标）把宠物甩到墙上弹个不停 */
const FLING_MAX_SPEED = 3.0;
/** 每 16.67ms 保留的速度比例；0.915 ≈ 0.8 秒滑完约 370px */
const FLING_FRICTION = 0.915;
/** 低于这个速度就停下（px/ms），否则会永远做无意义的亚像素抖动 */
const FLING_STOP_SPEED = 0.04;
/** 最后一次 mousemove 距松手超过这么久 = 手已经停了，速度按 0 算 */
const FLING_MAX_GAP_MS = 120;
/** 撞墙反弹保留的比例（0.55 → 弹回约一半，再撞再衰减） */
const FLING_BOUNCE = 0.55;
/** 法向速度低于这个值时不播挤压动画，避免贴边抖动疯狂 Q 弹 */
const FLING_IMPACT_MIN_SPEED = 0.12;
/** 速度采样只留最近这么多次（够算最后两帧，也够跳过 dt≈0 的重复帧） */
const FLING_SAMPLE_KEEP = 6;
/** 挤压动画时长，必须与 style.css 的 impact-squash-* 关键帧一致 */
const IMPACT_SQUASH_MS = 460;
/** 两次挤压之间的最小间隔，防止一帧内两个轴同时撞墙时叠两次动画 */
const IMPACT_COOLDOWN_MS = 80;
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

// -----------------------------------------------------------------------------
// Phase 3.24：待办事项
//
// 存储格式（需求指定）：
//   pet_todos = [{ id: Date.now(), text: "任务内容", completed: false }, ...]
//
// 设计取舍：
//   ① key 独立于 chat_history / favor —— 清记忆不该顺手清掉待办；
//   ② 写入永远走 persistTodos()，绝不在增删改里各写一遍 JSON.stringify，
//      否则漏一处就会出现「界面变了、刷新又回来」的灵异现象；
//   ③ 文案是产品需求给定的，改台词只动 TODO_LINES 这一处；
//   ④ 反馈不新造文本框：欢呼切桌宠本体差分（一件 Q 版 / 全部九头身），台词走现有 #bubble。
// -----------------------------------------------------------------------------
const TODO_STORAGE_KEY = 'pet_todos';
/** 单条任务最长 120 字：和 input 的 maxlength 保持一致，防手改 storage 塞长文 */
const TODO_MAX_LEN = 120;
/** 完成一件：桌宠切到欢呼差分，持续 4.2 秒 */
const TODO_CHEER_MS = 4200;
/** 全部完成：欢呼久一点，够看清最后一下 */
const TODO_CHEER_ALL_MS = 6400;
/** [MANUAL] 完成一件的欢呼差分（Q 版，和需求给的第一张图一致） */
const TODO_SPRITE_DONE = './assets/pet-cheer.png';
/** [MANUAL] 全部完成的欢呼差分（九头身，和需求给的第二张图一致） */
const TODO_SPRITE_ALL = './assets/pet-max-cheer.png';
/** 每勾选完成一件 +2 好感（需求指定；只在未完成 → 完成时加） */
const TODO_FAVOR_PER_TASK = 2;
/** 待办页顶部旁白停留时长：够读完一句，又不会一直占着列表空间 */
const TODO_SAY_MS = 6500;
/** [MANUAL] 台词：需求原文，不要随手改语气 */
const TODO_LINES = {
  add: ['啧，又给自己找事做？', '记下了，别到时候又忘了。'],
  done: '总算干完一件，算你还有点用。',
  allDone: '（抱着白米饭） 哟，效率挺高嘛，奖励你休息五分钟！',
};

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
/**
 * Phase 3.16：四张「基础表情」。
 *
 * 为什么不再按档位换图了：
 *   档位（low/high/max）本来也会换立绘，但那样一来「心情」和「清晰度」就共用了
 *   同一个 <img>，两套规则抢 src 必然打架。现在分工彻底拆开：
 *     · 档位  → 只决定画框尺寸 + 模型参数（DEPTHS.w / DEPTHS.h / model…）
 *     · 表情  → 只决定显示哪张图（本状态机）
 *   三档立绘文件保留在 assets/ 里，想恢复旧行为只需改 applyDepth 一行。
 *
 * 四张图都是 384×384、同样的内容长边，来回切换时角色不会忽大忽小。
 * ⚠️ 这些图已经抠过底（白背景 + 右下角水印都清掉了），抱枕 / Z 字气泡 /
 *    水珠 / 聊天泡全部保留 —— 直接覆盖同名 png 即可换表情，不用改代码。
 */
const PET_FACES = {
  pot: './assets/pet-pot.png', // 铁盆常态（头顶铁盆，也是被甩出去时的防御姿态）
  idle: './assets/pet-idle.png', // 死鱼眼 + 聊天泡
  sad: './assets/pet-sad.png', // 含泪 + 汗滴
  sleep: './assets/pet-sleep.png', // 抱枕 + Z 字气泡
  code: './assets/pet-code.png', // 番茄钟专注中：抱着笔记本猛敲
  // 被甩飞：标准档没有专门的「铁盆慌张」差分，复用 pot ——
  // 这张本来就是顶着铁盆的站姿，是同一套素材里最接近的一张。
  panic: './assets/pet-pot.png',
  // 欢呼（Phase 3.23）：双臂高举的「好耶」。两处用得上 ——
  // 番茄钟专注结束、猜拳把玩家打输。384×384，与其它四张同规格。
  cheer: './assets/pet-cheer.png',
};

/**
 * Phase 3.17：极致（max）档的同一套四表情，九头身版本。
 *
 * 为什么单独一份而不是复用：max 是 412x1116 的九头身立绘，画框也是
 * 210x315 的竖框，直接套 384x384 的 Q 版会把角色压扁。
 * 所以这四张是照着 pet-max.png 重新生成的差分，抠图后按「脸宽 = pet-max 的脸宽」
 * 对齐 —— 切表情时头部大小不变，只有姿势和表情变。
 * pot 就是 pet-max.png 本身（九头身常态）。
 */
const PET_MAX_FACES = {
  pot: './assets/pet-max.png',
  idle: './assets/pet-max-idle.png', // 死鱼眼 + 省略号气泡
  sad: './assets/pet-max-sad.png', // 含泪 + 汗滴
  sleep: './assets/pet-max-sleep.png', // 抱枕 + Z 字气泡（抱膝坐姿）
  code: './assets/pet-max-code.png', // 番茄钟专注中：抱着笔记本猛敲
  panic: './assets/pet-max-panic.png', // 被甩飞：头顶铁盆 + 慌张（双手扶盆沿）
  cheer: './assets/pet-max-cheer.png', // 欢呼：九头身版，同样高举双臂（Phase 3.23）
};

/**
 * 档位 → 表情包。没有条目的档位（low）保持原样：只换档位立绘，不参与表情。
 * 加新档位的表情包只要在这里加一行，其余逻辑不用动。
 */
const FACE_PACKS = {
  high: PET_FACES,
  max: PET_MAX_FACES,
};

/** 表情的合法值（脏值一律回落到 pot） */
const FACE_POT = 'pot';
const FACE_IDLE = 'idle';
const FACE_SAD = 'sad';
const FACE_SLEEP = 'sleep';
/** 番茄钟专注中（Phase 3.18）：只有标准 / 极致有这张差分，轻量档不换图 */
const FACE_CODE = 'code';
/**
 * 被甩飞 / 在空中（Phase 3.19）：极致档专用「铁盆慌张」差分。
 * 标准档没有这张图，applyFace() 会按 PET_FACES 查表回落到 pot ——
 * Q 版 pot 本来就是顶着铁盆的站姿，语义正好对得上；轻量档同理不换图。
 */
const FACE_PANIC = 'panic';
/**
 * 欢呼（Phase 3.23）：双臂高举的「好耶」。
 * 触发点只有两个，都是「她心情最好」的时刻：
 *   · 番茄钟专注结束 —— 陪你熬完一轮的那一下；
 *   · 猜拳玩家输 —— 她赢了，当然要举双手。
 * 轻量档照旧不换图（applyFace 内部会拦）。
 */
const FACE_CHEER = 'cheer';

/** 超过这么久没有任何点击 / 拖拽 / 发消息，就进入睡眠（需求：60 秒） */
const SLEEP_AFTER_MS = 60 * 1000;
/** 好感度分界（需求：<20 哭、20–39 死鱼眼、≥40 铁盆） */
const FAVOR_SAD_BELOW = 20;
const FAVOR_IDLE_BELOW = 40;
/** 被戳醒时的台词；连续戳不会复读（见 WAKE_LINE_COOLDOWN_MS） */
const WAKE_LINE = '啧，干嘛吵醒我？';
const WAKE_LINE_COOLDOWN_MS = 5000;

/**
 * 表情包作用在哪些档位（Phase 3.17 起是「标准 + 极致」）。
 *
 * 需求：轻量（low）保持原样 —— 仍然按档位显示 pet-low.png，
 * 不参与睡眠 / 好感度 / 甩飞的表情切换。
 * 想全体启用，把这里改成 null 即可（见 usesFacePack）。
 */
const FACE_PACK_DEPTH = ['high', 'max'];

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
// Phase 3.22：猜拳小游戏
//
// 这是一局「纯本地」的石头剪刀布：
//   · 不联网、不调模型、不写 chat_history —— 猜拳是玩，不是对话。
//     塞进上下文只会让下一轮回答莫名其妙地提到「剪刀」；
//   · 出拳用 Math.random()：她不需要「公平」，但也不需要作弊，
//     真随机反而是最省事、最不会出 bug 的做法；
//   · 唯一的持久化副作用是好感度（赢 +3 / 输 -1 / 平 0），走 writeFavor。
//
// 放在 FACE_* 常量之后：GAME_FACE 直接引用表情常量，
// 写在前面会撞上 const 的暂时性死区（ReferenceError）。
// -----------------------------------------------------------------------------

/** 三种手势，顺序就是按钮的排列顺序（石头 / 剪刀 / 布） */
const GAME_HANDS = ['rock', 'scissors', 'paper'];
const GAME_HAND_LABEL = { rock: '石头', scissors: '剪刀', paper: '布' };
/** 谁赢谁：GAME_BEATS[a] === b 表示 a 打败 b */
const GAME_BEATS = { rock: 'scissors', scissors: 'paper', paper: 'rock' };

/** 好感度增减（需求指定）。平局不加不减，所以不进这张表 */
const GAME_FAVOR = { win: 3, lose: -1, draw: 0 };

/**
 * 三句人设台词（需求原文，别顺手改写语气）。
 * 玩家赢 → 她撇嘴不认账；玩家输 → 她嘲讽；平局 → 死鱼眼。
 */
const GAME_LINES = {
  win: '（撇嘴） 啧，运气真好。这局不算，再来！',
  lose: '就这？笨蛋，你连我都赢不了。',
  draw: '（半睁死鱼眼） 默契什么的最讨厌了。',
};

/**
 * 输赢对应的表情：赢了她不服气（含泪汗滴 = sad），输了翘尾巴（pot），
 * 平局一脸无所谓（idle）。轻量档没有表情包，applyFace 会自己回落到档位立绘。
 */
const GAME_FACE = { win: FACE_SAD, lose: FACE_CHEER, draw: FACE_IDLE };
// -----------------------------------------------------------------------------
// [AI-GEN] Phase 3.27：天气页（#bubble 的第六个视图）
//
// 只做「展示 + 挑台词 + 背景氛围」，联网和日期都在主进程（main.js）。
// 天气页和聊天 / 待办 / 设置共用同一个 #bubble：
//   · 页签负责切换，不再有独立卡片和单独定位；
//   · 背景按 weather.kind 切换，雨 / 雪 / 云 / 雾 / 晴天各自有动态层；
//   · 台词仍走对话框，不另造 toast，也不写 state.history。
// -----------------------------------------------------------------------------
/** 10 分钟内重复打开不重复请求；点「刷新」永远强制拉最新 */
const WEATHER_CACHE_MS = 10 * 60 * 1000;
/** [MANUAL] 天气类型对应的图标；改图标只动这里 */
const WEATHER_ICONS = {
  sunny: '☀️',
  rain: '🌧️',
  cloudy: '☁️',
  snow: '❄️',
  fog: '🌫️',
  storm: '⛈️',
  other: '🌤️',
  error: '🌐',
  loading: '⏳',
};
/** [MANUAL] 天气台词：第一句是需求原文，第二句是补充，改语气只动这里 */
const WEATHER_LINES = {
  sunny: [
    '（半睁死鱼眼） 太阳这么大，晒死了，你快去涂防晒。',
    '（用尾巴挡太阳） 晒死了……你出门记得戴帽子，别回来又喊头疼。',
  ],
  rain: [
    '（抱着枕头） 啧，外面下雨了，笨蛋，出门记得带伞，别淋成落汤鸡。',
    '（把枕头抱紧） 雨声烦死了。你要出门就带伞，淋湿了别找我。',
  ],
  cloudy: [
    '（打了个哈欠） 天气不冷不热的，适合睡觉，你不许偷懒。',
    '（瘫在枕头上） 这天气最适合睡觉……你敢偷懒试试。',
  ],
  snow: [
    '（把尾巴缩起来） 下雪了，冷死了……你出门多穿点，别指望我提醒第二次。',
    '（缩成一团） 外面白茫茫的，路滑，笨蛋走路看着点。',
  ],
  fog: [
    '（眯起眼睛） 雾这么大，路都看不清，你走路给我看着点。',
    '（探出头又缩回去） 这雾……出门别乱跑，迷路了我可不找你。',
  ],
  storm: [
    '（捂住耳朵） 打雷了，笨蛋，别站在窗边，过来陪我。',
    '（把枕头盖在头上） 雷声吵死了……你别乱跑，就在屋里待着。',
  ],
  other: [
    '（歪头） 这天气怪怪的，你自己看着办，别感冒就行。',
    '（一脸嫌弃） 什么鬼天气……算了，你出门注意点。',
  ],
  error: ['（皱眉） 连天气都查不到，你这网是断了吗？'],
};

/** 没有主进程（浏览器预览 / API 缺失）时的日期兜底 */
// -----------------------------------------------------------------------------
// Phase 3.28：查询地区
//   · WEATHER_DEFAULT_LOCATION 必须与 main.js 的兜底城市保持一致；
//   · WEATHER_QUICK_CITIES 是「常用城市」快捷项，坐标写死，点一下不联网；
//   · 用户选过的城市存 localStorage；键名改掉就等于清空老用户的选择。
// -----------------------------------------------------------------------------
const WEATHER_LOCATION_KEY = 'pet_weather_location';
const WEATHER_DEFAULT_LOCATION = { name: '北京', latitude: 39.9042, longitude: 116.4074 };
const WEATHER_QUICK_CITIES = [
  { name: '北京', latitude: 39.9042, longitude: 116.4074 },
  { name: '上海', latitude: 31.2304, longitude: 121.4737 },
  { name: '广州', latitude: 23.1291, longitude: 113.2644 },
  { name: '深圳', latitude: 22.5431, longitude: 114.0579 },
  { name: '杭州', latitude: 30.2741, longitude: 120.1551 },
  { name: '成都', latitude: 30.5728, longitude: 104.0668 },
  { name: '西安', latitude: 34.3416, longitude: 108.9398 },
  { name: '武汉', latitude: 30.5928, longitude: 114.3055 },
];

function localDateTextForWeather() {
  const d = new Date();
  const week = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  const p2 = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + week[d.getDay()];
}

function formatWeatherNumber(value) {
  if (!Number.isFinite(Number(value))) return '--';
  return String(Math.round(Number(value) * 10) / 10);
}

function pickWeatherLine(kind) {
  const key = WEATHER_LINES[kind] ? kind : 'other';
  const lines = WEATHER_LINES[key];
  return lines[Math.floor(Math.random() * lines.length)] || lines[0];
}

function setMenuWeatherLabel() {
  if (!petMenuWeather) return;
  petMenuWeather.textContent = state.weatherOpen ? '📅 隐藏今日天气' : '📅 查看今日天气';
}

/** 天气页底部的旁白。没有自动消失：用户切走 / 刷新时才替换。 */
// -----------------------------------------------------------------------------
// Phase 3.28：地区选择
//   数据流：输入城市名 → searchLocation（主进程走 Open-Meteo 地名接口）
//        → 候选列表 → 选中 → 存 localStorage → 用新坐标重拉天气。
//   地区面板是天气页内部的浮层，所以命中检测、随气泡移动这些都自动继承。
// -----------------------------------------------------------------------------

/** 校验一份城市数据；任何字段不对就返回 null（宁可退回默认城市，也不要脏数据上屏） */
function normalizeWeatherLocationInput(input) {
  if (!input || typeof input !== 'object') return null;
  const latitude = Number(input.latitude);
  const longitude = Number(input.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) return null;
  const label =
    typeof input.label === 'string' && input.label.trim() ? input.label.trim() : name;
  return { name: name.slice(0, 40), label: label.slice(0, 80), latitude, longitude };
}

/** 读用户上次选的城市；解析失败 / 数据非法都当作「没选过」 */
function readStoredWeatherLocation() {
  try {
    const raw = localStorage.getItem(WEATHER_LOCATION_KEY);
    if (!raw) return null;
    return normalizeWeatherLocationInput(JSON.parse(raw));
  } catch (err) {
    return null;
  }
}

/** 写盘失败（隐私模式 / 配额满）不影响本次查询，所以静默吞掉 */
function writeStoredWeatherLocation(location) {
  try {
    localStorage.setItem(
      WEATHER_LOCATION_KEY,
      JSON.stringify({
        name: location.name,
        label: location.label || location.name,
        latitude: location.latitude,
        longitude: location.longitude,
      })
    );
  } catch (err) {
    /* 存不下就算了，这次仍然按新城市查 */
  }
}

/** 把当前城市同步到「头部按钮 + 温度下面那行」，两处必须一致 */
function renderWeatherLocationLabels() {
  const name = state.weatherLocation.name;
  if (weatherLocName) weatherLocName.textContent = name;
  if (weatherPlace) weatherPlace.textContent = name;
  if (weatherLocBtn) weatherLocBtn.title = '当前地区：' + name + '（点击切换）';
}

function setWeatherLocStatus(text, busy) {
  if (!weatherLocStatus) return;
  const value = typeof text === 'string' ? text : '';
  weatherLocStatus.textContent = value;
  weatherLocStatus.hidden = !value;
  weatherLocStatus.classList.toggle('is-busy', Boolean(busy));
}

function setWeatherLocBusy(busy) {
  state.weatherLocBusy = Boolean(busy);
  if (weatherLocSearch) weatherLocSearch.disabled = state.weatherLocBusy;
  if (weatherLocInput) weatherLocInput.disabled = state.weatherLocBusy;
}

/** 渲染候选列表；每条都是 <button>，点一下即切换 */
function renderWeatherLocResults() {
  if (!weatherLocResults) return;
  weatherLocResults.textContent = '';
  const list = Array.isArray(state.weatherLocResults) ? state.weatherLocResults : [];
  const current = state.weatherLocation;
  list.forEach((item) => {
    const li = document.createElement('li');
    li.className = 'weather-loc-item';
    const isCurrent =
      Math.abs(item.latitude - current.latitude) < 0.01 &&
      Math.abs(item.longitude - current.longitude) < 0.01;
    if (isCurrent) li.classList.add('is-current');

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'weather-loc-option';
    btn.setAttribute('role', 'option');
    btn.setAttribute('aria-selected', isCurrent ? 'true' : 'false');

    const main = document.createElement('span');
    main.className = 'weather-loc-option-name';
    main.textContent = item.name + (isCurrent ? '（当前）' : '');
    const sub = document.createElement('span');
    sub.className = 'weather-loc-option-sub';
    sub.textContent = item.label || item.name;

    btn.appendChild(main);
    btn.appendChild(sub);
    btn.addEventListener('click', () => selectWeatherLocation(item));
    li.appendChild(btn);
    weatherLocResults.appendChild(li);
  });
}

/** 常用城市按钮：只填一次，重复开面板不重建 DOM */
function fillWeatherQuickCities() {
  if (!weatherLocQuick || weatherLocQuick.dataset.filled === '1') return;
  WEATHER_QUICK_CITIES.forEach((city) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'weather-loc-chip';
    btn.textContent = city.name;
    btn.addEventListener('click', () => selectWeatherLocation(city));
    weatherLocQuick.appendChild(btn);
  });
  weatherLocQuick.dataset.filled = '1';
}

function openWeatherLocPanel() {
  if (!weatherLocPanel) return;
  state.weatherLocOpen = true;
  weatherLocPanel.hidden = false;
  if (weatherLocBtn) weatherLocBtn.setAttribute('aria-expanded', 'true');
  fillWeatherQuickCities();
  renderWeatherLocResults();
  if (weatherLocStatus && weatherLocStatus.hidden) {
    setWeatherLocStatus('输入城市名搜索，或直接选下方常用城市', false);
  }
  if (weatherLocInput) {
    weatherLocInput.focus();
    if (typeof weatherLocInput.select === 'function') weatherLocInput.select();
  }
}

function closeWeatherLocPanel() {
  if (!state.weatherLocOpen) return;
  state.weatherLocOpen = false;
  if (weatherLocPanel) weatherLocPanel.hidden = true;
  if (weatherLocBtn) weatherLocBtn.setAttribute('aria-expanded', 'false');
  if (state.weatherLocTimer) {
    clearTimeout(state.weatherLocTimer);
    state.weatherLocTimer = 0;
  }
  setWeatherLocBusy(false);
}

function toggleWeatherLocPanel() {
  if (state.weatherLocOpen) closeWeatherLocPanel();
  else openWeatherLocPanel();
}

/** 搜索城市：序号防抖，连点只认最后一次 */
async function searchWeatherLocation(keyword) {
  const query = typeof keyword === 'string' ? keyword.trim() : '';
  const seq = ++state.weatherLocSeq;

  if (!query) {
    state.weatherLocResults = [];
    renderWeatherLocResults();
    setWeatherLocStatus('输入城市名搜索，或直接选下方常用城市', false);
    return;
  }

  if (!api || typeof api.searchLocation !== 'function') {
    state.weatherLocResults = [];
    renderWeatherLocResults();
    setWeatherLocStatus('当前环境不支持地区搜索，先用下方常用城市吧', false);
    return;
  }

  setWeatherLocBusy(true);
  setWeatherLocStatus('正在搜索「' + query + '」…', true);

  let result = null;
  try {
    result = await api.searchLocation(query);
  } catch (err) {
    result = null;
  }

  if (seq !== state.weatherLocSeq) return; // 已经被更新的搜索取代
  setWeatherLocBusy(false);

  const list =
    result && result.ok === true && Array.isArray(result.results) ? result.results : [];
  const cleaned = [];
  list.forEach((item) => {
    const normalized = normalizeWeatherLocationInput(item);
    if (normalized) cleaned.push(normalized);
  });

  state.weatherLocResults = cleaned;
  renderWeatherLocResults();

  if (cleaned.length) {
    setWeatherLocStatus('找到 ' + cleaned.length + ' 个地区，点一条即可切换', false);
    return;
  }
  const failed = !result || result.ok !== true;
  setWeatherLocStatus(
    failed ? '地区搜索失败，检查网络后重试' : '没找到「' + query + '」，换个写法试试',
    false
  );
}

/** 选中一个城市：存盘 → 立刻用新坐标重拉（缓存必须一起作废） */
function selectWeatherLocation(location) {
  const next = normalizeWeatherLocationInput(location);
  if (!next) return false;

  state.weatherLocation = {
    name: next.name,
    label: next.label,
    latitude: next.latitude,
    longitude: next.longitude,
  };
  writeStoredWeatherLocation(state.weatherLocation);
  renderWeatherLocationLabels();
  closeWeatherLocPanel();

  state.weatherData = null;
  state.weatherLoadedAt = 0;
  state.weatherLine = '';
  loadWeather(true);
  return true;
}

function showWeatherSay(text) {
  const line = String(text == null ? '' : text).trim();
  if (!weatherSay || !line) return false;
  weatherSay.textContent = line;
  weatherSay.hidden = false;
  weatherSay.classList.remove('is-new');
  // 强制一次布局，让同一条台词刷新时也能重新播放入场动画
  if (typeof weatherSay.offsetWidth === 'number') void weatherSay.offsetWidth;
  weatherSay.classList.add('is-new');
  if (state.bubbleOpen) relayoutBubble();
  return true;
}

function weatherClockText(timestamp) {
  const d = new Date(timestamp || Date.now());
  const p2 = (n) => String(n).padStart(2, '0');
  return p2(d.getHours()) + ':' + p2(d.getMinutes()) + ' 更新';
}

// —— 天气背景：用固定种子的伪随机，刷新时雨滴/雪花分布稳定，不会乱跳 ——
function weatherSeed(n) {
  const value = Math.sin(n * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

function addWeatherFx(className, vars) {
  if (!weatherFx || typeof document === 'undefined') return null;
  const node = document.createElement('i');
  node.className = className;
  const props = vars && typeof vars === 'object' ? vars : {};
  Object.keys(props).forEach((key) => {
    node.style.setProperty(key, String(props[key]));
  });
  weatherFx.appendChild(node);
  return node;
}

/**
 * 按天气类型重建背景动态层。
 * 只在类型变化时重建；同一类型重复渲染时不碰 DOM，避免雨滴每次刷新都「闪一下」。
 */
function renderWeatherFx(kind) {
  if (!weatherFx) return;
  const next = ['sunny', 'rain', 'cloudy', 'snow', 'fog', 'storm', 'other', 'error', 'loading'].includes(kind)
    ? kind
    : 'other';
  if (state.weatherFxKind === next) return;
  state.weatherFxKind = next;
  weatherFx.textContent = '';

  if (next === 'sunny') {
    addWeatherFx('sun-core');
    addWeatherFx('sun-rays');
  }

  if (next === 'cloudy' || next === 'rain' || next === 'storm') {
    for (let i = 0; i < 4; i += 1) {
      addWeatherFx('cloud-puff', {
        '--x': (weatherSeed(i + 1) * 78 + 4).toFixed(2) + '%',
        '--y': (weatherSeed(i + 2) * 34 + 3).toFixed(2) + '%',
        '--w': (58 + weatherSeed(i + 3) * 60).toFixed(0) + 'px',
        '--h': (20 + weatherSeed(i + 4) * 22).toFixed(0) + 'px',
        '--dur': (10 + weatherSeed(i + 5) * 12).toFixed(2) + 's',
        '--delay': (-weatherSeed(i + 6) * 12).toFixed(2) + 's',
        '--op': (0.12 + weatherSeed(i + 7) * 0.12).toFixed(2),
      });
    }
  }

  if (next === 'rain' || next === 'storm') {
    for (let i = 0; i < 40; i += 1) {
      addWeatherFx('rain-drop', {
        '--x': (weatherSeed(i + 11) * 100).toFixed(2) + '%',
        '--delay': (-weatherSeed(i + 12) * 3).toFixed(2) + 's',
        '--dur': (0.72 + weatherSeed(i + 13) * 0.7).toFixed(2) + 's',
        '--len': (10 + weatherSeed(i + 14) * 20).toFixed(1) + 'px',
        '--op': (0.28 + weatherSeed(i + 15) * 0.5).toFixed(2),
      });
    }
  }

  if (next === 'snow') {
    for (let i = 0; i < 32; i += 1) {
      addWeatherFx('snow-flake', {
        '--x': (weatherSeed(i + 21) * 100).toFixed(2) + '%',
        '--delay': (-weatherSeed(i + 22) * 9).toFixed(2) + 's',
        '--dur': (6 + weatherSeed(i + 23) * 7).toFixed(2) + 's',
        '--size': (3 + weatherSeed(i + 24) * 4).toFixed(1) + 'px',
        '--drift': (-24 + weatherSeed(i + 25) * 48).toFixed(1) + 'px',
        '--op': (0.45 + weatherSeed(i + 26) * 0.45).toFixed(2),
      });
    }
  }

  if (next === 'fog') {
    for (let i = 0; i < 5; i += 1) {
      addWeatherFx('fog-band', {
        '--y': (10 + i * 19).toFixed(0) + '%',
        '--h': (26 + weatherSeed(i + 31) * 30).toFixed(0) + 'px',
        '--dur': (8 + weatherSeed(i + 32) * 8).toFixed(2) + 's',
        '--delay': (-weatherSeed(i + 33) * 8).toFixed(2) + 's',
        '--op': (0.12 + weatherSeed(i + 34) * 0.14).toFixed(2),
      });
    }
  }

  if (next === 'storm') {
    addWeatherFx('lightning');
  }
}

function renderWeather(result) {
  if (!weatherPage) return;
  const data = result && typeof result === 'object' ? result : null;
  // 主进程会回声这次查询用的城市名；以它为准，保证头部按钮与温度下面那行永远一致。
  if (data && data.location && typeof data.location.name === 'string' && data.location.name) {
    state.weatherLocation.name = data.location.name;
  }
  renderWeatherLocationLabels();
  const dateText = (data && data.date) || localDateTextForWeather();
  if (weatherDate) weatherDate.textContent = '📅 ' + dateText;

  if (!data || data.ok !== true || !data.weather) {
    weatherPage.dataset.kind = 'error';
    weatherPage.classList.add('is-error');
    weatherPage.classList.remove('is-loading');
    if (weatherIcon) weatherIcon.textContent = WEATHER_ICONS.error;
    if (weatherTemp) weatherTemp.textContent = '--';
    if (weatherCond) {
      weatherCond.hidden = true;
      weatherCond.textContent = '';
    }
    if (weatherBody) weatherBody.textContent = '天气获取失败';
    if (weatherUpdated) weatherUpdated.textContent = '更新失败';
    renderWeatherFx('error');
    refreshIgnore();
    return;
  }

  const w = data.weather;
  const kind = WEATHER_ICONS[w.kind] ? w.kind : 'other';
  weatherPage.dataset.kind = kind;
  weatherPage.classList.remove('is-error', 'is-loading');

  if (weatherIcon) weatherIcon.textContent = WEATHER_ICONS[kind];
  if (weatherTemp) weatherTemp.textContent = formatWeatherNumber(w.temperature) + '°C';
  if (weatherCond) {
    weatherCond.textContent = w.condition || '天气';
    weatherCond.hidden = false;
  }
  if (weatherBody) {
    weatherBody.textContent = '🌬️ 风速 ' + formatWeatherNumber(w.windSpeed) + ' km/h';
  }
  if (weatherUpdated) weatherUpdated.textContent = weatherClockText(state.weatherFetchedAt);
  renderWeatherFx(kind);
  refreshIgnore();
}

function setWeatherLoading(loading) {
  state.weatherLoading = Boolean(loading);
  if (weatherRefresh) {
    weatherRefresh.disabled = state.weatherLoading;
    weatherRefresh.textContent = state.weatherLoading ? '刷新中…' : '刷新';
  }
  if (!weatherPage) return;
  weatherPage.classList.toggle('is-loading', state.weatherLoading);
  if (state.weatherLoading) {
    weatherPage.dataset.kind = 'loading';
    weatherPage.classList.remove('is-error');
    if (weatherIcon) weatherIcon.textContent = WEATHER_ICONS.loading;
    if (weatherTemp) weatherTemp.textContent = '--';
    if (weatherCond) {
      weatherCond.hidden = true;
      weatherCond.textContent = '';
    }
    if (weatherBody) weatherBody.textContent = '正在获取天气…';
    if (weatherUpdated) weatherUpdated.textContent = '连接中';
    if (weatherSay) {
      weatherSay.hidden = true;
      weatherSay.textContent = '';
    }
    renderWeatherFx('loading');
  }
}

/**
 * 拉天气。
 * force=false：10 分钟内复用缓存（打开天气页 / 重复点菜单不反复请求）；
 * force=true ：刷新按钮，永远重新请求。
 */
async function loadWeather(force) {
  if (!weatherPage) return;
  if (state.weatherLoading) return;

  if (
    !force &&
    state.weatherData &&
    state.weatherData.ok === true &&
    state.weatherLoadedAt &&
    nowMs() - state.weatherLoadedAt < WEATHER_CACHE_MS
  ) {
    renderWeather(state.weatherData);
    if (state.weatherOpen) {
      const kind = state.weatherData.weather ? state.weatherData.weather.kind : 'other';
      if (!state.weatherLine) state.weatherLine = pickWeatherLine(kind);
      showPetAside(state.weatherLine);
    }
    return;
  }

  const seq = ++state.weatherSeq;
  setWeatherLoading(true);

  let result = null;
  try {
    if (api && typeof api.getWeatherAndDate === 'function') {
      // Phase 3.28：把当前城市传下去；主进程会做校验，非法坐标自动退回默认城市。
      result = await api.getWeatherAndDate({
        name: state.weatherLocation.name,
        latitude: state.weatherLocation.latitude,
        longitude: state.weatherLocation.longitude,
      });
    } else {
      result = { ok: false, error: '天气获取失败', date: localDateTextForWeather() };
    }
  } catch (err) {
    result = { ok: false, error: '天气获取失败', date: localDateTextForWeather() };
  }

  // 连点 / 切走页面：只让最后一次请求写 UI，避免旧结果覆盖新结果
  if (seq !== state.weatherSeq) return;

  setWeatherLoading(false);
  state.weatherData = result;
  state.weatherLoadedAt = nowMs();
  if (result && result.ok === true && result.weather) state.weatherFetchedAt = Date.now();
  renderWeather(result);

  const kind = result && result.ok === true && result.weather ? result.weather.kind : 'error';
  state.weatherLine = pickWeatherLine(kind);
  if (state.weatherOpen) showPetAside(state.weatherLine);
}

/** 打开天气页：复用同一个 #bubble，不再定位第二块悬浮卡片 */
function openWeatherPanel() {
  if (!viewWeather) return;
  if (state.weatherOpen) return;
  if (!state.bubbleOpen) openBubble();
  if (!state.bubbleOpen) return;
  setPanel('weather');
  markActive();
  if (api && typeof api.focusWindow === 'function') api.focusWindow();
  loadWeather(false);
}

/** 收起天气页 = 收起整个对话框；下次左键打开仍从聊天页开始 */
function closeWeatherPanel() {
  if (!state.weatherOpen) return;
  closeBubble();
}

function toggleWeatherPanel() {
  if (state.weatherOpen) closeWeatherPanel();
  else openWeatherPanel();
}

function bindWeatherEvents() {
  if (weatherRefresh) {
    weatherRefresh.addEventListener('click', () => {
      loadWeather(true);
    });
  }
  if (weatherClose) {
    weatherClose.addEventListener('click', () => {
      closeWeatherPanel();
    });
  }

  // —— Phase 3.28：地区选择 ——
  // 先把上次选的城市读回来，再渲染标签；没存过就保持默认城市。
  const storedLocation = readStoredWeatherLocation();
  if (storedLocation) state.weatherLocation = storedLocation;
  renderWeatherLocationLabels();

  if (weatherLocBtn) {
    weatherLocBtn.addEventListener('click', () => {
      toggleWeatherLocPanel();
    });
  }
  if (weatherLocClose) {
    weatherLocClose.addEventListener('click', () => {
      closeWeatherLocPanel();
    });
  }
  if (weatherLocForm) {
    weatherLocForm.addEventListener('submit', (event) => {
      event.preventDefault();
      searchWeatherLocation(weatherLocInput ? weatherLocInput.value : '');
    });
  }
  if (weatherLocInput) {
    weatherLocInput.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        // 输入框里的 Esc 只收浮层，不要连带把整个气泡收掉
        event.preventDefault();
        closeWeatherLocPanel();
      }
    });
    // 边打字边搜：450ms 防抖，序号机制保证只有最后一次结果上屏
    weatherLocInput.addEventListener('input', () => {
      if (state.weatherLocTimer) clearTimeout(state.weatherLocTimer);
      const value = weatherLocInput.value;
      state.weatherLocTimer = setTimeout(() => {
        state.weatherLocTimer = 0;
        searchWeatherLocation(value);
      }, 450);
    });
  }

  setMenuWeatherLabel();
}

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
  panel: 'chat', // 当前显示哪个视图：'chat' | 'settings' | 'wallet' | 'game'
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

  // —— 基础状态机（Phase 3.16）——
  face: FACE_POT, // 当前表情：'pot' | 'idle' | 'sad' | 'sleep' | 'code'
  faceSrc: '', // 当前真正写进 <img> 的地址（判重用，避免同图重复解码）
  imageSeq: 0, // 换图序号：解码慢的旧请求不许盖掉新表情
  sleeping: false, // 是否睡着（60 秒无交互后自动入睡）
  airborne: false, // 是否正在被甩飞（空中强制铁盆）
  lastActiveAt: 0, // 最后一次「用户还在」的时间戳（ms）
  sleepTimer: 0, // 睡眠巡检的 setInterval id
  wakeLineAt: 0, // 上次说「干嘛吵醒我」的时间，用来防连点刷屏

  // —— 番茄钟（Phase 3.18）——
  // pomodoro 是主进程快照的本地副本。渲染进程不推进它，
  // 所以这里的时间**只会跳变到主进程说的值**，自己绝不会多走一秒。
  pomodoro: { phase: POMO_IDLE, remainingMs: 0, totalMs: 0 },
  pomoChipSize: { w: 0, h: 0 }, // 胶囊实测尺寸（定位用）
  // Phase 3.23：「好耶」窗口。用时间戳而不是布尔 —— 布尔要靠定时器复位，
  // 定时器被节流的常驻窗口里一旦漏掉一次，她就会永远举着手。
  cheerUntil: 0,
  cheerTimer: 0, // 只为让单元测试能立刻清干净，复位本身靠 cheerUntil 判定
  menuOpen: false, // 右键菜单是否展开
  menuPos: { x: 0, y: 0 }, // 菜单左上角
  menuSize: { w: 0, h: 0 }, // 菜单实测尺寸
  bigDialogTimer: 0, // 大号对话框的复位定时器

  // —— Phase 3.21：剪贴板吐槽 + 语音 ——
  // speechOn 只是「设置里的开关」，真正的发声条件是 speechOn && 系统有语音引擎。
  speechOn: false,
  clipRoastOn: true,
  // 被动气泡：这次打开没抢焦点，所以要自己定时收起（没有 blur 事件可依赖）
  roastPassive: false,
  roastTimer: 0,
  lastRoastFp: '', // 上一条吐槽的指纹（渲染侧再拦一道重复）
  lastRoastAt: 0,

  // —— Phase 3.22：猜拳 ——
  // 一局牌桌的全部状态。故意做成一个对象而不是散字段：
  // 退出时要一口气复位（见 endGame），散字段最容易被漏掉一个，
  // 然后就会出现「上次的 sfx 还在 / 表情停在 sad」这类残留。
  game: {
    active: false, // 牌局是否开着（开着才拦番茄钟菜单、才不让睡）
    round: 0, // 已经打了几局（比分文案用）
    wins: 0,
    losses: 0,
    draws: 0,
    last: '', // 上一局结果：'win' | 'lose' | 'draw' | ''
    over: true, // 本局是否已出结果（手牌 / 结果按钮的显示开关）
    face: '', // 牌桌上的表情覆盖值；空 = 没有覆盖
  },

  // —— Phase 3.24：待办 ——
  // 面板开合状态不持久化：重启后保持收起，避免一开屏就挡住桌面。
  todoOpen: false,
  todos: [], // [{ id, text, completed }]，唯一事实来源
  todoRect: { x: 0, y: 0, w: 0, h: 0 }, // 面板视口矩形（命中检测用）
  todoCheerSrc: '', // 待办完成时临时强制显示的欢呼图
  todoCheerUntil: 0, // 上述强制显示的截止时间戳

  // —— Phase 3.25：待办页顶部旁白 ——
  // 台词显示在 #bubble 内部（#todo-say），到点自动收起；定时器句柄存这里。
  todoSayTimer: 0,

  // —— Phase 3.27：天气页（#bubble 的第六个视图）——
  // 天气页和气泡共用开合：weatherOpen 只是「当前页签是不是天气」。
  weatherOpen: false,
  weatherSeq: 0, // 请求序号：连点刷新时只让最后一次写 UI
  weatherData: null, // 最近一次主进程返回
  weatherLoadedAt: 0, // 成功缓存的起点（nowMs）
  weatherFetchedAt: 0, // 数据自身的抓取时间（Date.now，给「xx:xx 更新」用）
  weatherLine: '',
  weatherLoading: false,
  weatherFxKind: '', // 当前背景动效类型，避免重复重建 DOM

  // —— Phase 3.28：查询地区 ——
  // weatherLocation 是「正在查的城市」，默认与 main.js 的兜底城市一致；
  // 启动时 bindWeatherEvents() 会用 localStorage 里存的城市覆盖它。
  weatherLocation: {
    name: WEATHER_DEFAULT_LOCATION.name,
    label: WEATHER_DEFAULT_LOCATION.name,
    latitude: WEATHER_DEFAULT_LOCATION.latitude,
    longitude: WEATHER_DEFAULT_LOCATION.longitude,
  },
  weatherLocOpen: false, // 地区选择浮层是否展开
  weatherLocSeq: 0, // 搜索序号：连点只认最后一次
  weatherLocResults: [], // 当前候选地区
  weatherLocBusy: false, // 搜索中（禁用输入框与搜索按钮）
  weatherLocTimer: 0, // 输入防抖定时器
};

// 一次「按下 → 移动 → 松开」的临时状态
const press = {
  active: false, // 是否正处于「按住球体」的过程中
  moved: false, // 是否已经超过阈值（= 升级成拖拽了）
  woke: false, // 这一下点击是不是把她从睡眠里戳醒的（松手时要补台词）
  startX: 0, // 按下时的鼠标位置
  startY: 0,
  offsetX: 0, // 按下时鼠标相对球体左上角的偏移
  offsetY: 0,
};
/**
 * Phase 3.15：惯性滑行的运行时状态。
 * 和 press 分开的原因：press 是「手还按着」的状态，fling 是「手已经松开、
 * 但宠物还在飞」的状态 —— 两者互斥（按下时一定要先把 fling 停掉）。
 */
const fling = {
  samples: [], // 最近几次拖拽采样 { x, y, t }，t 是 performance.now()
  raf: 0, // 当前 rAF id
  active: false, // 是否正在滑行
  vx: 0, // 速度（px/ms）
  vy: 0,
  lastT: 0, // 上一帧时间戳，用来算真实 dt
  lastImpactAt: -Infinity, // 上次挤压的时间，做冷却
  impactTimer: 0, // 挤压类名的移除定时器
};

// -----------------------------------------------------------------------------
// Phase 3.15：时间 / 帧 / 动效偏好
//
// ⚠️ 全部做 typeof 守卫：renderer.js 也会被 Node 单测（node:vm）加载，
//    那个环境里没有 requestAnimationFrame / performance，直接调用会当场崩掉。
// -----------------------------------------------------------------------------
function nowMs() {
  if (
    typeof performance !== 'undefined' &&
    performance &&
    typeof performance.now === 'function'
  ) {
    return performance.now();
  }
  return Date.now();
}

/** 统一的「减少动态效果」判断（系统辅助功能打开时不甩、不挤压） */
function prefersReducedMotion() {
  return (
    typeof matchMedia === 'function' &&
    matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function nextFrame(cb) {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(cb);
  // 没有 rAF 的环境（Node 单测）退化成定时器：逻辑一致，只是精度差一点
  return setTimeout(() => cb(nowMs()), 16);
}

function cancelFrame(id) {
  if (!id) return;
  if (typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(id);
  } else if (typeof clearTimeout === 'function') {
    clearTimeout(id);
  }
}

// -----------------------------------------------------------------------------
// 工具函数
// -----------------------------------------------------------------------------
function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/** 把球体逻辑坐标写到 DOM 上（translate3d 方案） */
function applyTransform() {
  pet.style.transform = `translate3d(${state.pos.x}px, ${state.pos.y}px, 0)`;
  // 番茄钟小胶囊是「长在角色身上」的，位置一变就得跟着走。
  // 放在这里而不是每个调用点各写一遍：applyTransform 是位置的唯一写入口。
  positionPomoChip();
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

/** 指针是否落在打开中的右键菜单上 */
function isPointOnMenu(clientX, clientY) {
  if (!state.menuOpen) return false;
  const p = state.menuPos;
  const { w, h } = state.menuSize;
  return clientX >= p.x && clientX <= p.x + w && clientY >= p.y && clientY <= p.y + h;
}

/** 可交互区域 = 球体 ∪ 打开中的气泡 ∪ 打开中的菜单。只有在这里面才关闭穿透。 */
function isPointInteractive(clientX, clientY) {
  return (
    isPointOnPet(clientX, clientY) ||
    isPointOnBubble(clientX, clientY) ||
    isPointOnMenu(clientX, clientY)
  );
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

  // 7.6) Phase 3.16：好感度读回来才知道该长什么样（启动时的 applyDepth
  //      只用了默认 50，这里用真实数值再纠正一次）。用 instant 避免开屏闪图。
  state.lastActiveAt = nowMs();
  updateBaseState({ instant: true });
  startSleepWatch();

  // 7.7) Phase 3.18：订阅番茄钟推送 + 拉一次当前状态。
  //      放在 updateBaseState 之后：状态回来时才知道该不该换成「敲代码 / 睡姿」。
  bindPomodoroEvents();

  // 7.8) Phase 3.21：语音 / 剪贴板吐槽。
  //      两个开关都从 localStorage 恢复；剪贴板监听由这里「按需开启」，
  //      所以主进程在用户关掉之后不会继续偷看剪贴板。
  applySpeechSetting(readSpeechOn());
  applyClipRoastSetting(readClipRoastOn());
  bindClipboardEvents();

  // 7.9) Phase 3.24：恢复待办 + 绑定面板事件。
  //      面板保持收起；数据从 localStorage 读回来即可（重启不丢）。
  initTodo();

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

  // Phase 3.24：待办面板固定在右上角，气泡默认也往右上角摆，两边会互相挡。
  // 面板优先（用户正在里面打字），气泡按这个顺序让位：
  //   ① 面板正下方、角色头顶上方（最自然，尾巴还能指向角色）；
  //   ② 面板左侧（角色被拖到屏幕上方、下面塞不下时）；
  //   ③ 实在没地方就贴屏幕底，至少别被面板盖住。
  // 侧移后不再画小尾巴：尾巴原本指向角色，横着摆会指到空处。
  let side = false;
  const panel = state.todoRect;
  if (state.todoOpen && panel.w > 0) {
    const hitsPanel =
      x < panel.x + panel.w &&
      x + w > panel.x &&
      y < panel.y + panel.h &&
      y + h > panel.y;
    if (hitsPanel) {
      const gap = 6;
      const belowY = panel.y + panel.h + gap;
      const leftX = panel.x - w - gap * 2;
      if (belowY + h <= state.pos.y + 4) {
        // 面板下方还有一条缝：右对齐角色，尾巴朝下指回去
        y = belowY;
        x = clamp(x, 0, maxX);
        arrow = 'down';
      } else if (leftX >= 0) {
        x = leftX;
        side = true;
      } else {
        y = Math.min(maxY, belowY);
        x = clamp(x, 0, maxX);
      }
    }
  }
  if (bubble.classList) bubble.classList.toggle('bubble--side', side);

  state.bubblePos.x = x;
  state.bubblePos.y = y;
  bubble.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  bubble.dataset.arrow = arrow;

  // 气泡在上方时，倒计时胶囊要让到角色脚下（见 positionPomoChip）
  positionPomoChip();
}

function openBubble() {
  if (state.bubbleOpen || !bubble) return;
  state.bubbleOpen = true;

  document.body.classList.add('bubble-open');
  bubble.setAttribute('aria-hidden', 'false');

  // Phase 3.21：设置页要按「角色现在的位置」重新算可用高度，
  // 否则拖到屏幕下半部分再打开设置，气泡会翻到角色身上。
  fitSettingsHeight();
  measureBubble();
  positionBubble();

  // 让窗口拿到焦点：这样键盘输入能直接进输入框，
  // 同时「点桌面别处」会触发 blur，气泡就能自动收起。
  // 焦点交给「当前视图」决定 —— 设置页要落在 key 输入框上。
  if (api && api.focusWindow) api.focusWindow();
  focusPanel();

  // 气泡刚占据上方空间，胶囊要立刻让位（否则会叠在一起一瞬）
  positionPomoChip();

  refreshIgnore();
}

function closeBubble() {
  if (!state.bubbleOpen || !bubble) return;
  state.bubbleOpen = false;

  document.body.classList.remove('bubble-open');
  bubble.setAttribute('aria-hidden', 'true');

  if (bubbleInput) bubbleInput.blur();

  // Phase 3.21：被动弹的吐槽气泡收起来了，定时器和标记一起清掉
  clearRoastTimer();
  state.roastPassive = false;

  // 收气泡时无条件退出输入法友好模式：blur 在部分情况下（窗口失焦）不会触发
  setImeFriendly(false);

  // 钱包是「临时插播」，关掉后回到聊天，下次左键点开还是熟悉的输入框
  resetWalletView();

  // Phase 3.22：牌局同理，而且必须先复位再收 —— 否则表情会停在「输了」那张脸上。
  // 表情重算由 endGame 内部负责（它知道这次到底有没有在玩）。
  resetGameView();

  // 气泡收起后上方空出来了，胶囊回到头顶
  positionPomoChip();

  // Phase 3.25 / 3.27：待办页 / 天气页同样是「临时视图」——
  // 关掉整个对话框就回到聊天页，下次左键打开还是熟悉的输入框。
  if (state.panel === 'todo' || state.panel === 'weather') setPanel('chat');

  refreshIgnore();
}

/** 单击球体：开着就收起，没开就展开；钱包开着则切回聊天（点一下就能打字） */
function toggleBubble() {
  if (state.bubbleOpen) {
    // Phase 3.21：如果这次气泡是「吐槽被动弹出来的」，用户点球体的本意
    // 一定是「我要用」，而不是「关掉」—— 所以这一下只把焦点接过来。
    if (state.roastPassive) {
      state.roastPassive = false;
      clearRoastTimer();
      if (api && api.focusWindow) api.focusWindow();
      focusPanel();
      return;
    }
    if (state.panel === 'wallet') {
      setPanel('chat');
      return;
    }
    // Phase 3.22：牌局中点球体 = 关面板，按需求回到「聊天待机」。
    // closeBubble 会负责结束牌局并重算表情（见 resetGameView）。
    closeBubble();
  } else {
    openBubble();
  }
}

// -----------------------------------------------------------------------------
// Phase 3.21：剪贴板吐槽气泡
// -----------------------------------------------------------------------------

function clearRoastTimer() {
  if (!state.roastTimer) return;
  clearTimeout(state.roastTimer);
  state.roastTimer = 0;
}

function scheduleRoastClose() {
  clearRoastTimer();
  state.roastTimer = setTimeout(() => {
    state.roastTimer = 0;
    if (state.roastPassive && state.bubbleOpen) closeBubble();
  }, ROAST_VISIBLE_MS);
}

/**
 * 被动打开气泡：不抢窗口焦点、不聚焦输入框。
 * 和 openBubble 的唯一区别就是「不 focusWindow / 不 focusPanel」——
 * 少了这一步，你在 VS Code 里打字时她弹一句吐槽，你的光标就飞走了。
 */
function openBubblePassive() {
  if (!bubble) return false;
  if (state.bubbleOpen) return true;

  state.bubbleOpen = true;
  state.roastPassive = true;

  document.body.classList.add('bubble-open');
  bubble.setAttribute('aria-hidden', 'false');

  measureBubble();
  positionBubble();
  positionPomoChip();
  refreshIgnore();
  return true;
}

/**
 * 收到剪贴板命中后：挑台词 → 追加到聊天流 → 弹被动气泡 → 定时收起。
 * 正在设置页 / 钱包页时不打扰（用户手上正干别的事）。
 * @returns {boolean} 是否真的吐槽了
 */
function showRoast(kind, text) {
  if (!state.clipRoastOn) return false;
  if (state.panel !== 'chat') return false;

  const raw = String(text == null ? '' : text);
  if (!raw) return false;

  const line = pickRoastLine(kind === 'code' ? 'code' : 'error');

  openBubblePassive();
  appendMessage('roast', line, { plain: true });
  scheduleRoastClose();
  return true;
}

/**
 * 主进程送来的剪贴板事件。
 * 主进程已经做过「同一内容只报一次」，这里再按指纹拦一道：
 * 页面重载后订阅可能叠了两份，不加拦会导致同一句话连说两遍。
 */
function onClipboardHint(payload) {
  if (!state.clipRoastOn) return false;
  if (!payload || typeof payload !== 'object') return false;

  const kind = payload.kind === 'code' ? 'code' : 'error';
  const text = typeof payload.text === 'string' ? payload.text : '';
  if (!text) return false;

  const fp = kind + '|' + text.length + '|' + text.slice(0, 80);
  const now = Date.now();
  if (state.lastRoastFp === fp && now - state.lastRoastAt < 10000) return false;
  state.lastRoastFp = fp;
  state.lastRoastAt = now;

  return showRoast(kind, text);
}

function bindClipboardEvents() {
  if (!api || typeof api.onClipboardHint !== 'function') return;
  api.onClipboardHint((payload) => onClipboardHint(payload));
}

// =============================================================================
// [AI-GEN] Phase 3.24：待办事项（存储 / 渲染 / 面板 / 对话反馈）
//
// [MANUAL] 需要人工确认的只有两处（都在下方常量里）：
//   · TODO_LINES —— 人设台词，需求原文，别随手改语气；
//   · TODO_STORAGE_KEY —— 存储键名，改了就相当于清空老用户的待办。
// 其余增删改 / 渲染 / 定位 / 穿透 / 反馈逻辑均为 [AI-GEN]。
// =============================================================================

/** localStorage 里的单条任务 → 干净对象；坏数据返回 null */
function normalizeTodo(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const text = typeof entry.text === 'string' ? entry.text.trim() : '';
  if (!text) return null;
  const rawId = Number(entry.id);
  const id = Number.isFinite(rawId) && rawId > 0 ? Math.floor(rawId) : Date.now();
  return {
    id,
    text: text.slice(0, TODO_MAX_LEN),
    completed: entry.completed === true,
  };
}

/** 读待办；JSON 坏了 / storage 不可用都退化成空数组（待办丢了不致命） */
function readTodos() {
  if (!hasLocalStorage()) return [];
  let raw = null;
  try {
    raw = JSON.parse(localStorage.getItem(TODO_STORAGE_KEY) || '[]');
  } catch (err) {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  raw.forEach((entry) => {
    const todo = normalizeTodo(entry);
    if (!todo) return;
    // 手改 storage 可能造出重复 id，删除时会一次删两条 —— 这里直接修好
    while (seen.has(todo.id)) todo.id += 1;
    seen.add(todo.id);
    out.push(todo);
  });
  return out;
}

/** 写待办；返回是否真的落盘。任何增删改都必须走这里 */
function persistTodos() {
  if (!hasLocalStorage()) return false;
  const clean = state.todos.map(normalizeTodo).filter(Boolean);
  try {
    localStorage.setItem(TODO_STORAGE_KEY, JSON.stringify(clean));
    return true;
  } catch (err) {
    console.warn('[PromptPet] 待办写入失败（storage 已满或被禁用）', err);
    return false;
  }
}

/** 新 id：需求要求 Date.now()，同毫秒连加两条时 +1 撞开，保证唯一 */
function makeTodoId() {
  let id = Date.now();
  const used = new Set(state.todos.map((todo) => todo.id));
  while (used.has(id)) id += 1;
  return id;
}

/** 生成一条任务 DOM。⚠️ 任务文字只用 textContent，绝不拼 innerHTML */
function createTodoItem(todo) {
  const item = document.createElement('li');
  item.className = 'todo-item' + (todo.completed ? ' todo-item--done' : '');
  item.dataset.id = String(todo.id);

  const check = document.createElement('button');
  check.type = 'button';
  check.className = 'todo-check';
  check.setAttribute('role', 'checkbox');
  check.setAttribute('aria-checked', todo.completed ? 'true' : 'false');
  check.setAttribute('aria-label', todo.completed ? '标记为未完成' : '标记为已完成');
  check.title = todo.completed ? '标记为未完成' : '标记为已完成';
  check.textContent = todo.completed ? '✓' : '';
  check.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleTodo(todo.id);
  });

  const text = document.createElement('button');
  text.type = 'button';
  text.className = 'todo-text';
  text.textContent = todo.text;
  text.title = todo.completed ? '点击标记为未完成' : '点击标记为已完成';
  text.addEventListener('click', (event) => {
    event.preventDefault();
    toggleTodo(todo.id);
  });

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'todo-del';
  del.textContent = '✕';
  del.title = '删除这条';
  del.setAttribute('aria-label', '删除任务：' + todo.text);
  del.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    deleteTodo(todo.id);
  });

  item.appendChild(check);
  item.appendChild(text);
  item.appendChild(del);
  return item;
}

/** 全量重渲染。数据一变就调用它，界面永远不会和 state 不一致 */
function renderTodos() {
  const pending = state.todos.filter((todo) => !todo.completed);
  const done = state.todos.filter((todo) => todo.completed);

  if (todoPending) {
    const frag = document.createDocumentFragment();
    pending.forEach((todo) => frag.appendChild(createTodoItem(todo)));
    todoPending.textContent = '';
    todoPending.appendChild(frag);
  }
  if (todoDone) {
    const frag = document.createDocumentFragment();
    done.forEach((todo) => frag.appendChild(createTodoItem(todo)));
    todoDone.textContent = '';
    todoDone.appendChild(frag);
  }

  if (todoPendingCount) todoPendingCount.textContent = String(pending.length);
  if (todoDoneCount) todoDoneCount.textContent = String(done.length);
  if (todoCount) {
    todoCount.textContent = `${done.length}/${state.todos.length}`;
    todoCount.title = `已完成 ${done.length} / 共 ${state.todos.length}`;
  }
  // 只有一条任务都没有时才显示空态；「全做完了」应该看到已完成的战绩
  if (todoEmpty) todoEmpty.hidden = state.todos.length > 0;

  // 列表条数变了 → 面板高度变了 → 命中矩形必须跟着更新
  syncTodoRect();
}

/** Phase 3.25：待办并入 #bubble，不再有独立面板矩形（保留空实现兼容旧调用） */
function syncTodoRect() {
  state.todoRect = { x: 0, y: 0, w: 0, h: 0 };
}

function isPointOnTodo() {
  // 待办页就在气泡里，命中交给 isPointOnBubble —— 这里永远不成立。
  return false;
}

function setMenuTodoLabel() {
  if (!petMenuTodo) return;
  petMenuTodo.textContent = state.todoOpen ? '📝 收起待办事项' : '📝 呼出待办事项';
}

/** 打开待办页：和天气页同构，复用同一个 #bubble，不另开悬浮面板 */
function openTodoPanel() {
  if (!viewTodo) return;
  if (state.todoOpen) return;
  if (!state.bubbleOpen) openBubble();
  if (!state.bubbleOpen) return;
  setPanel('todo');
  markActive();
  if (api && typeof api.focusWindow === 'function') api.focusWindow();
}

/** 收起待办页 = 收起整个对话框；下次左键打开仍从聊天页开始 */
function closeTodoPanel() {
  if (!state.todoOpen) return;
  closeBubble();
}

function toggleTodoPanel() {
  if (state.todoOpen) closeTodoPanel();
  else openTodoPanel();
}

/** 新增一条任务；成功返回 true（空字符串 / 纯空格不算） */
function addTodo(source) {
  const value = String(source == null ? '' : source).trim().slice(0, TODO_MAX_LEN);
  if (!value) return false;

  state.todos.push({
    id: makeTodoId(),
    text: value,
    completed: false,
  });
  persistTodos();
  renderTodos();
  renderTodos();
  markActive();
  wakeUp(); // 睡着时加任务也要有反应，不然气泡对着抱枕说话

  const lines = TODO_LINES.add;
  const line = lines[Math.floor(Math.random() * lines.length)] || lines[0];
  showTodoDialog(line);
  return true;
}

/**
 * 勾选 / 取消勾选。
 * 好感度只在「未完成 → 完成」时 +2；取消勾选不扣分（需求没要求惩罚，
 * 扣分只会让用户不敢改错别字）。
 */
function toggleTodo(id) {
  const todo = state.todos.find((entry) => entry.id === id);
  if (!todo) return false;

  const wasCompleted = todo.completed;
  todo.completed = !todo.completed;
  persistTodos();
  renderTodos();
  markActive();
  wakeUp();

  if (!wasCompleted && todo.completed) {
    state.favor = clampFavor(state.favor + TODO_FAVOR_PER_TASK);
    writeFavor(state.favor);
    updateBaseState();

    const allDone = state.todos.length > 0 && state.todos.every((entry) => entry.completed);
    if (allDone) {
      // 最后一件：桌宠本体换成九头身欢呼差分，台词走现有对话框
      showTodoCheer(TODO_SPRITE_ALL, TODO_CHEER_ALL_MS);
      showTodoDialog(TODO_LINES.allDone);
    } else {
      showTodoCheer(TODO_SPRITE_DONE, TODO_CHEER_MS);
      showTodoDialog(TODO_LINES.done);
    }
  }
  return true;
}

function deleteTodo(id) {
  const index = state.todos.findIndex((entry) => entry.id === id);
  if (index < 0) return false;
  state.todos.splice(index, 1);
  persistTodos();
  renderTodos();
  markActive();
  return true;
}

/**
 * 待办欢呼：把「指定差分」临时按在桌宠身上，优先级高于牌局 / 番茄钟。
 *
 * 为什么不直接 showCheer()：
 *   showCheer 会按当前深度选图（标准 Q 版 / 极致九头身），但需求要求
 *   「完成一件 = Q 版、全部完成 = 九头身」这两张固定差分，不能随档位漂。
 *   所以这里只负责把 src 钉住，计时和重绘仍复用 showCheer 的窗口。
 */
function showTodoCheer(src, ms) {
  const span = Number(ms) > 0 ? Number(ms) : TODO_CHEER_MS;
  state.todoCheerSrc = String(src || '');
  state.todoCheerUntil = nowMs() + span;
  showCheer(span);
}

/**
 * 待办页顶部的一句旁白。它长在 #bubble 内部，不是第二个悬浮窗；
 * 用户勾任务时列表不会被聊天页替换，也能立刻看到她说了什么。
 */
/** 收起待办页顶部旁白（切走视图 / 关闭气泡时调用） */
function clearTodoSay() {
  if (state.todoSayTimer) {
    clearTimeout(state.todoSayTimer);
    state.todoSayTimer = 0;
  }
  if (!todoSay) return;
  todoSay.hidden = true;
  todoSay.textContent = '';
  todoSay.classList.remove('is-new');
}

function showTodoSay(line) {
  if (!todoSay) return;
  const text = String(line == null ? '' : line).trim();
  if (!text) return;

  if (state.todoSayTimer) clearTimeout(state.todoSayTimer);
  todoSay.textContent = text;
  todoSay.hidden = false;
  // 重新触发一次入场动画：连续勾选时也有「刚说话」的反馈
  todoSay.classList.remove('is-new');
  if (typeof todoSay.offsetWidth === 'number') void todoSay.offsetWidth;
  todoSay.classList.add('is-new');

  state.todoSayTimer = setTimeout(() => {
    state.todoSayTimer = 0;
    if (!todoSay) return;
    todoSay.hidden = true;
    todoSay.textContent = '';
    todoSay.classList.remove('is-new');
    if (state.todoOpen && state.bubbleOpen) relayoutBubble();
  }, TODO_SAY_MS);

  if (state.bubbleOpen) relayoutBubble();
}
/**
 * 让大肥鱼在现有气泡里说一句「旁白」。
 *
 * 待办完成、天气加载都用它，避免每个功能各写一套弹窗逻辑。
 * 行为：
 *   · 待办页开着 → 追加聊天流，并在列表顶部显示同一句旁白；
 *   · 聊天页开着 → 直接往聊天流追加「她自己的嘀咕」；
 *   · 气泡没开 → 被动打开（不抢焦点），8 秒后自动收；
 *   · 正在设置 / 钱包 / 牌局 → 只记进聊天流，不硬切视图；
 *   · 只进 DOM，不进 state.history，不会污染喂给模型的上下文。
 */
function showPetAside(text) {
  const line = String(text == null ? '' : text).trim();
  if (!line) return false;

  speakText(line);

  // 待办页：列表保持可见，台词走页内旁白（同一个气泡里的元素）。
  if (state.panel === 'todo') {
    appendMessage('roast', line, { plain: true });
    showTodoSay(line);
    return true;
  }

  // 天气页：聊天流照写，旁白落在页内 #weather-say。
  if (state.panel === 'weather') {
    appendMessage('roast', line, { plain: true });
    showWeatherSay(line);
    return true;
  }

  // 设置 / 钱包 / 牌局正占着气泡：别把用户手上的视图切走。
  // 话仍写进聊天流，等他们回到聊天页能看见。
  if (state.panel !== 'chat') {
    appendMessage('roast', line, { plain: true });
    return false;
  }

  if (!state.bubbleOpen) {
    if (!openBubblePassive()) {
      appendMessage('roast', line, { plain: true });
      return false;
    }
  }
  appendMessage('roast', line, { plain: true });

  // 复用「被动气泡」的生命周期：点角色接管、点别处或超时自动收。
  // 用户自己开着的聊天不擅自关。
  if (state.roastPassive) scheduleRoastClose();
  return true;
}

/** 待办反馈的语义化包装：欢呼差分 + 台词都走同一套旁白通道 */
function showTodoDialog(text) {
  return showPetAside(text);
}
/** 待办相关事件：表单 / 关闭按钮 / 输入法保护 */
function bindTodoEvents() {
  // 中文输入法：选字时按回车是「确认候选词」，不能顺手把半成品加进列表。
  // 单行 input 的 form submit 在部分 Chromium 版本里会抢在 compositionend 之前触发，
  // 所以用一个标志位在提交口再拦一道（与聊天框的 isComposing 判断同一目的）。
  let composing = false;
  if (todoInput) {
    todoInput.addEventListener('compositionstart', () => {
      composing = true;
    });
    todoInput.addEventListener('compositionend', () => {
      composing = false;
    });
  }

  if (todoForm) {
    todoForm.addEventListener('submit', (event) => {
      event.preventDefault();
      if (composing) return;
      if (addTodo(todoInput ? todoInput.value : '')) {
        if (todoInput) todoInput.value = '';
      }
      if (todoInput && typeof todoInput.focus === 'function') todoInput.focus();
    });
  }

  if (todoClose) {
    todoClose.addEventListener('click', (event) => {
      event.preventDefault();
      closeTodoPanel();
    });
  }

  // Enter 由 form 的 submit 接管（中文输入法候选框里的 Enter 不会误提交）；
  // Esc 交给全局 handleEscape（菜单 → 待办 → 气泡的层级顺序）。
}

/**
 * 启动时恢复待办。
 * 待办页本身保持收起：数据要持久化，但「开着待办页」不是用户数据。
 */
function initTodo() {
  state.todos = readTodos();
  bindTodoEvents();
  renderTodos();
  setMenuTodoLabel();
}

// -----------------------------------------------------------------------------
// 事件绑定
// -----------------------------------------------------------------------------
function bindEvents() {
  // ① 全程监听鼠标移动：既做「命中检测」，也做「拖拽跟随」
  window.addEventListener('mousemove', onMouseMove, { passive: true });

  // ② 在球上按下鼠标：进入「待定」状态
  pet.addEventListener('mousedown', onMouseDown);

  // ②b 右键球体：打开菜单（Phase 3.18 起不再是「直接查余额」）
  pet.addEventListener('contextmenu', onPetContextMenu);

  // ②c 菜单项点击：用事件委托，菜单项增删不用改这里
  if (petMenu) {
    petMenu.addEventListener('click', (event) => {
      const target = event.target && event.target.closest
        ? event.target.closest('.pet-menu-item')
        : null;
      if (!target) return;
      event.preventDefault();
      handlePetMenuAction(target.getAttribute('data-action'));
    });
  }

  // ③ 松手：决定这次到底是单击还是拖拽
  window.addEventListener('mouseup', onMouseUp);

  // ④ 指针离开窗口（多显示器 / 快速甩出）时兜底恢复穿透，
  //    否则窗口会一直处于「拦截点击」状态，挡住桌面。
  window.addEventListener('mouseleave', () => {
    if (!press.active) setIgnoreMouse(true);
  });

  // ⑤ 窗口失焦（Cmd+Tab 切走、或用户点了桌面别处）：
  //    取消进行中的拖拽，收起菜单和气泡 —— 这就是「点击外部关闭」。
  window.addEventListener('blur', () => {
    cancelInteraction();
    closePetMenu();
    setImeFriendly(false);
    if (state.bubbleOpen) closeBubble();
  });

  // ⑤b 点空白处关菜单（用 mousedown，见 onDocumentMouseDown 的说明）
  window.addEventListener('mousedown', onDocumentMouseDown, true);
  // 菜单是 fixed 定位，屏幕尺寸一变就得关掉重开（否则会停在错的位置）；
  // 待办页也依赖视口尺寸，气泡开着就重新量、重新摆。
  window.addEventListener('resize', () => {
    closePetMenu();
    // 视口尺寸变了，气泡（含待办 / 天气页）要重新量、重新摆
    if (state.bubbleOpen) relayoutBubble();
  });

  // ⑥ 输入法专属：聚焦到文本控件时降窗口层级，让候选词面板浮上来。
  //    ⚠️ focus / blur 不冒泡，所以直接绑到三个输入框上（不要用 focusin 委托）。
  [bubbleInput, keyInput, todoInput].forEach((field) => {
    if (!field) return;
    field.addEventListener('focus', () => {
      setImeFriendly(true);
      // 被动弹出来的气泡（剪贴板吐槽 / 待办反馈）一旦用户点进输入框，
      // 就说明他要用了：立刻取消 8 秒自动收，别打着字突然消失。
      if (field === bubbleInput && state.roastPassive) {
        state.roastPassive = false;
        clearRoastTimer();
      }
    });
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
      // Phase 3.16：拖拽也算「还在用」，否则拖到一半会被睡眠巡检打断
      markActive();
      // 记录这一帧的鼠标位置，松手时用它算「甩出去」的初速度
      pushFlingSample(clientX, clientY);
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

  // 在右键菜单上按下：交给按钮，别把桌宠拖走
  if (state.menuOpen && isPointOnMenu(x, y)) return;

  if (!isPointOnPet(x, y)) return; // 防止误触发

  // 菜单开着却去按桌宠：先把菜单收掉，避免两个浮层同时存在
  closePetMenu();

  // 指针位置平时由 mousemove 维护；但「直接按下去、中间没动过」的情况下
  // （触控板轻点、自动化脚本）它可能还是旧的，导致松手时误判「不在宠物上」。
  // 按下就以事件坐标为准，松手后的命中判断才靠得住。
  state.pointer.x = x;
  state.pointer.y = y;

  // 半空中被抓住：立刻停住（不然拖拽和 rAF 会同时写 state.pos，互相打架）
  stopFling();

  // Phase 3.16：按下的瞬间就醒 —— 不等到松手，
  // 因为「睡着的图」在这一下之后还要继续显示几十毫秒，会显得反应很慢。
  // 台词放到 mouseup 再说（那时才能区分「点一下」和「拖走」）。
  markActive();
  const woke = wakeUp();

  // 先「待定」，不立刻决定是拖拽还是点击
  press.active = true;
  press.moved = false;
  press.woke = woke;
  press.startX = x;
  press.startY = y;
  press.offsetX = x - state.pos.x;
  press.offsetY = y - state.pos.y;

  // 新的一次拖拽，速度采样从头开始
  fling.samples.length = 0;

  // 按住期间必须保证窗口能持续收到事件，否则 mouseup 会丢
  setIgnoreMouse(false);

  event.preventDefault();
}

function onMouseUp() {
  if (!press.active) return;

  const wasDrag = press.moved; // 移动过 = 拖拽；没移动过 = 单击
  const woke = press.woke; // 这一下是不是把她从睡梦里戳醒的
  const onPet = isPointOnPet(state.pointer.x, state.pointer.y);

  // Phase 3.15：松手这一刻的速度要在 resetPress() 之前读 ——
  // 这里读的是「手松开前的运动」，不是「松开后的状态」。
  const velocity = wasDrag ? readFlingVelocity() : { vx: 0, vy: 0 };

  resetPress();

  // 单击球体 -> 开关气泡。拖拽过就绝不触发，避免「拖完手一松弹出气泡」
  if (!wasDrag && onPet) {
    // Phase 3.16：戳醒的那一下不能顺手把气泡关掉 ——
    // 她要说的「干嘛吵醒我」就在气泡里，关掉等于白叫一声。
    if (woke) showWakeLine();
    else toggleBubble();
  }
  // 只是「按一下又拖走」也叫醒了，但不用说话；markActive 已在别处补过
  if (woke && wasDrag) markActive();

  // 拖拽松手：甩得够快就让宠儿继续滑；甩不动才走原来的「贴边吸附」。
  // 两条路径互斥 —— 一边跑 rAF 一边挂 CSS 过渡会互相抢 transform。
  if (wasDrag) {
    if (!startFling(velocity.vx, velocity.vy)) snapToNearestEdge();
  }

  refreshIgnore();
}

// -----------------------------------------------------------------------------
// Phase 3.15：惯性甩出（甩尾）
// -----------------------------------------------------------------------------

/** 拖拽过程中记录一个采样点（鼠标原始坐标 + 时间） */
function pushFlingSample(x, y) {
  const list = fling.samples;
  list.push({ x, y, t: nowMs() });
  if (list.length > FLING_SAMPLE_KEEP) {
    list.splice(0, list.length - FLING_SAMPLE_KEEP);
  }
}

/**
 * 松手时的速度（px/ms）。
 *
 * 需求是「最后两帧的坐标差」。直接用最后两帧有两个坑，所以这里做了兜底：
 *   ① 两帧的时间差可能接近 0（高刷屏 / 同一帧内连发多个 mousemove），
 *      除下去会得到天文数字 —— dt < 4ms 就再往前并一帧，直到够大；
 *   ② 用户拖到位后停了一下才松手，但采样还停在旧位置，
 *      此时硬算速度会让宠物莫名飞出去 —— 最后一个点超过 120ms 就直接判 0。
 */
function readFlingVelocity() {
  const list = fling.samples;
  const n = list.length;
  if (n < 2) return { vx: 0, vy: 0 };

  const last = list[n - 1];
  if (nowMs() - last.t > FLING_MAX_GAP_MS) return { vx: 0, vy: 0 };

  let i = n - 2;
  while (i > 0 && last.t - list[i].t < 4) i--;
  const prev = list[i];
  const dt = last.t - prev.t;
  if (!(dt > 0)) return { vx: 0, vy: 0 };

  let vx = (last.x - prev.x) / dt;
  let vy = (last.y - prev.y) / dt;

  // 矢量限速：只缩短、不改变方向
  const speed = Math.sqrt(vx * vx + vy * vy);
  if (speed > FLING_MAX_SPEED) {
    const k = FLING_MAX_SPEED / speed;
    vx *= k;
    vy *= k;
  }
  return { vx, vy };
}

/**
 * 开始惯性滑行。
 * 返回 false = 这次不甩（太慢 / 系统要求减少动态效果），调用方退回去吸附。
 */
function startFling(vx, vy) {
  const speed = Math.sqrt(vx * vx + vy * vy);
  if (!Number.isFinite(speed) || speed < FLING_MIN_SPEED) return false;
  // 辅助功能「减少动态效果」：不甩尾、不挤压，手感退化成「松手即停」
  if (prefersReducedMotion()) return false;

  stopFling();

  fling.active = true;
  fling.vx = vx;
  fling.vy = vy;
  fling.lastT = nowMs();

  // Phase 3.16：离手即「空中」——强制铁盆，落地（endFling）后由状态机收回
  state.airborne = true;
  updateBaseState({ instant: true });

  // 拖拽路径上可能残留 .snapping 过渡；不清掉的话 rAF 每帧写的 transform
  // 会被 CSS 过渡「追着跑」，滑行看起来又黏又慢。
  if (pet && pet.classList) {
    pet.classList.remove('snapping');
    pet.classList.add('flinging');
  }
  if (bubble && bubble.classList) bubble.classList.remove('snapping');

  fling.raf = nextFrame(stepFling);
  return true;
}

/**
 * 惯性主循环：一帧只做四件事 —— 衰减、积分、撞墙、收尾。
 * 所有物理量都用真实 dt 归一化，所以 60Hz / 120Hz 屏幕手感一致。
 */
function stepFling(stamp) {
  if (!fling.active) return;

  const t = typeof stamp === 'number' ? stamp : nowMs();
  let dt = t - fling.lastT;
  // 首帧 dt 可能为 0；从后台切回来可能几百毫秒 —— 都夹进合理范围，
  // 否则会出现「一帧瞬移半个屏幕」的鬼畜。
  if (!(dt > 0)) dt = 16.667;
  dt = Math.min(dt, 48);
  fling.lastT = t;

  // 指数衰减：把真实 dt 折算成「多少个 16.67ms」，不同刷新率观感一致
  const decay = Math.pow(FLING_FRICTION, dt / 16.667);
  fling.vx *= decay;
  fling.vy *= decay;

  const { w, h } = state.box;
  const maxX = Math.max(0, state.bounds.width - w);
  const maxY = Math.max(0, state.bounds.height - h);

  let x = state.pos.x + fling.vx * dt;
  let y = state.pos.y + fling.vy * dt;
  let hitX = 0; // -1 左墙 / +1 右墙
  let hitY = 0; // -1 顶边 / +1 底边

  if (x < 0) {
    x = 0;
    hitX = -1;
  } else if (x > maxX) {
    x = maxX;
    hitX = 1;
  }
  if (y < 0) {
    y = 0;
    hitY = -1;
  } else if (y > maxY) {
    y = maxY;
    hitY = 1;
  }

  // 撞击强度必须在「反向 + 衰减」之前取，否则算出来的永远是 0.55 倍
  const impactSpeed = Math.abs(hitX ? fling.vx : fling.vy);

  if (hitX) {
    fling.vx = -fling.vx * FLING_BOUNCE;
    if (Math.abs(fling.vx) < FLING_STOP_SPEED) fling.vx = 0;
  }
  if (hitY) {
    fling.vy = -fling.vy * FLING_BOUNCE;
    if (Math.abs(fling.vy) < FLING_STOP_SPEED) fling.vy = 0;
  }

  state.pos.x = x;
  state.pos.y = y;
  applyTransform();
  // 气泡全程跟着飞，否则会出现「球在飞、气泡留在原地」的穿帮
  if (state.bubbleOpen) positionBubble();

  // Q 弹：左右撞墙竖着压扁，上下落地横着压扁（需求里的 scale(1.1, 0.9)）
  if ((hitX || hitY) && impactSpeed >= FLING_IMPACT_MIN_SPEED) {
    triggerImpact(hitX ? 'x' : 'y');
  }

  // 飞过来正好从鼠标底下经过：临时恢复可交互，用户能一把抓住它；
  // 离开鼠标后必须立刻吐掉（setIgnoreMouse 内部有去重，不会每帧发 IPC）
  refreshIgnore();

  const speed = Math.sqrt(fling.vx * fling.vx + fling.vy * fling.vy);
  if (speed < FLING_STOP_SPEED) {
    // 自然停下：如果正好停在边缘 30px 内，仍然按 Phase 3.12 的规则吸附
    endFling(true);
    return;
  }

  fling.raf = nextFrame(stepFling);
}

/**
 * 结束滑行。
 * snap=true  → 走一次边缘吸附（保留原来的贴边手感）；
 * snap=false → 原地停住（用户中途抓住 / 窗口失焦时用）。
 */
function endFling(snap) {
  const wasActive = fling.active;
  fling.active = false;
  fling.vx = 0;
  fling.vy = 0;
  if (fling.raf) {
    cancelFrame(fling.raf);
    fling.raf = 0;
  }
  if (pet && pet.classList) pet.classList.remove('flinging');

  if (wasActive && snap) snapToNearestEdge();
  refreshIgnore();

  // Phase 3.16：真正落地了才恢复常态。
  // 只有「刚才确实在飞」才重算，避免 startFling 内部 stopFling 的空调用把表情抖一下。
  if (wasActive && state.airborne) {
    state.airborne = false;
    updateBaseState();
  }
}

/** 立即停住，不做吸附（按下 / 失焦 / 中断时用） */
function stopFling() {
  if (fling.raf) {
    cancelFrame(fling.raf);
    fling.raf = 0;
  }
  if (!fling.active) return;
  endFling(false);
}

/**
 * 撞墙挤压动画。
 *
 * 为什么不直接给 #pet 写 transform: scale(...)？
 *   #pet 的 transform 归 rAF 独占（translate3d 定位），同一帧再写 scale 会把位移覆盖掉。
 *   .pet-core 是内层、只负责动画，和 idle-breathe 用「同名属性互相覆盖」的规则切换，
 *   完全碰不到定位。
 */
function triggerImpact(axis) {
  if (!petCore || !petCore.classList) return;
  if (prefersReducedMotion()) return;

  const t = nowMs();
  // 冷却：一帧内两个轴同时撞角、或贴边小抖动，都不该连播两次
  if (t - fling.lastImpactAt < IMPACT_COOLDOWN_MS) return;
  fling.lastImpactAt = t;

  const cls = axis === 'x' ? 'impact-x' : 'impact-y';

  // 先摘再挂 + 强制重排：连撞两次时动画必须能从头重播，
  // 否则浏览器认为「类没变」而拒绝重启动画。
  petCore.classList.remove('impact-x', 'impact-y');
  void petCore.offsetWidth;
  petCore.classList.add(cls);

  if (fling.impactTimer && typeof clearTimeout === 'function') {
    clearTimeout(fling.impactTimer);
  }
  fling.impactTimer = setTimeout(() => {
    petCore.classList.remove('impact-x', 'impact-y');
    fling.impactTimer = 0;
  }, IMPACT_SQUASH_MS);
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
  const reduceMotion = prefersReducedMotion();

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
  press.woke = false;

  if (state.dragging) {
    state.dragging = false;
    pet.classList.remove('dragging');
    document.body.classList.remove('dragging');
  }
}

/** 中断进行中的交互（窗口失焦、指针飞出窗口时用） */
function cancelInteraction() {
  resetPress();
  // 失焦时宠物可能正在飞：必须停，否则切回来它还在滑
  stopFling();
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
  // Phase 3.16：好感度就是表情的输入，改完立刻重算，
  // 不要等到下一轮对话结束才换脸（那时用户早看到「该哭却没哭」了）。
  if (next !== before) updateBaseState();
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
  if (k.length <= 12) return 'sk-…';
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

// -----------------------------------------------------------------------------
// Phase 3.21：语音播报 + 剪贴板吐槽（设置读写 / 台词 / 朗读）
// -----------------------------------------------------------------------------

/** 'on' / 'off' 之外的任何脏值都当 off —— 语音是「多给的功能」，默认不出声 */
function normalizeOnOff(value, fallback) {
  const v = String(value == null ? '' : value)
    .trim()
    .toLowerCase();
  if (v === 'on' || v === 'off') return v;
  return fallback;
}

function readSpeechOn() {
  if (!hasLocalStorage()) return false;
  try {
    return normalizeOnOff(localStorage.getItem(SPEECH_STORAGE_KEY), 'off') === 'on';
  } catch (err) {
    return false;
  }
}

function writeSpeechOn(on) {
  if (!hasLocalStorage()) return false;
  const value = on ? 'on' : 'off';
  try {
    localStorage.setItem(SPEECH_STORAGE_KEY, value);
    return localStorage.getItem(SPEECH_STORAGE_KEY) === value;
  } catch (err) {
    return false;
  }
}

function readClipRoastOn() {
  if (!hasLocalStorage()) return true;
  try {
    return normalizeOnOff(localStorage.getItem(CLIP_ROAST_STORAGE_KEY), 'on') === 'on';
  } catch (err) {
    return true;
  }
}

function writeClipRoastOn(on) {
  if (!hasLocalStorage()) return false;
  const value = on ? 'on' : 'off';
  try {
    localStorage.setItem(CLIP_ROAST_STORAGE_KEY, value);
    return localStorage.getItem(CLIP_ROAST_STORAGE_KEY) === value;
  } catch (err) {
    return false;
  }
}

/** 有没有可用的语音引擎（node:vm 的测试环境里两样都没有，会安全地返回 false） */
function speechSupported() {
  return (
    typeof window !== 'undefined' &&
    !!window.speechSynthesis &&
    typeof window.speechSynthesis.speak === 'function' &&
    typeof SpeechSynthesisUtterance === 'function'
  );
}

const CHINESE_VOICE_HINTS = [
  'tingting',
  'ting-ting',
  'ting-ting',
  '婷婷',
  'meijia',
  '美佳',
  'sinji',
  'google 普通话',
  '普通话',
  'zh-cn',
];

/**
 * 挑一个中文女声。
 * macOS 自带 Tingting（婷婷），Chrome 里通常还有 Google 普通话 —— 都排在前面。
 * 找不到就返回 null，此时会用 u.lang='zh-CN' 让系统自己挑：宁可声音不对，
 * 也别因为「没匹配到名单」就整个不念。
 */
function pickChineseVoice() {
  if (!speechSupported()) return null;
  let voices = [];
  try {
    voices = window.speechSynthesis.getVoices() || [];
  } catch (err) {
    return null;
  }
  if (!voices.length) return null; // 首次调用常常是空的，等 voiceschanged 就好

  const score = (v) => {
    const name = String((v && v.name) || '').toLowerCase();
    const lang = String((v && v.lang) || '').toLowerCase();
    let s = 0;
    if (lang.indexOf('zh') === 0) s += 4;
    if (CHINESE_VOICE_HINTS.some((h) => name.indexOf(h) !== -1)) s += 3;
    if (v && v.localService) s += 1;
    return s;
  };

  const best = voices.slice().sort((a, b) => score(b) - score(a))[0];
  return score(best) >= 4 ? best : null;
}

/**
 * Markdown → 能念出来的纯文本。
 * 代码块直接替换成一句说明：读 `const a = 1` 出来只会是一串乱码般的符号。
 */
function stripMarkdownForSpeech(source) {
  let s = String(source == null ? '' : source);
  s = s.replace(/```[\s\S]*?```/g, ' 代码我就不念了 ');
  s = s.replace(/~~~[\s\S]*?~~~/g, ' 代码我就不念了 ');
  s = s.replace(/`([^`]*)`/g, '$1');
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  s = s.replace(/^\s{0,3}#{1,6}\s*/gm, '');
  s = s.replace(/^\s{0,3}>\s?/gm, '');
  s = s.replace(/^\s*[-*+]\s+/gm, '');
  s = s.replace(/^\s*\d+\.\s+/gm, '');
  s = s.replace(/^\s*[-*_]{3,}\s*$/gm, ' ');
  s = s.replace(/(\*\*|__)(.*?)\1/g, '$2');
  s = s.replace(/(\*|_)(.*?)\1/g, '$2');
  s = s.replace(/~~(.*?)~~/g, '$1');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/**
 * 截到 max 字以内，并尽量断在句子末尾。
 * 「念一半被打断」比「少念一句」更难受，所以优先级是：完整句子 > 完整字数。
 */
function clipForSpeech(text, max) {
  const s = String(text == null ? '' : text);
  if (s.length <= max) return s;

  const head = s.slice(0, max);
  const stops = ['。', '！', '？', '；', '.', '!', '?', ';'];
  let cut = -1;
  stops.forEach((ch) => {
    const i = head.lastIndexOf(ch);
    if (i > cut) cut = i;
  });
  // 断点太靠前（不到一半）就宁可硬切，否则每次只念一小句
  if (cut >= Math.floor(max * 0.5)) return head.slice(0, cut + 1);
  return head + '…';
}

function cancelSpeech() {
  if (!speechSupported()) return;
  try {
    window.speechSynthesis.cancel();
  } catch (err) {
    /* 有些环境（无音频设备）cancel 会抛，忽略即可 */
  }
}

/**
 * 念一段文本。
 * 每次先 cancel：连续两次回答不能叠着念（听起来像两个人在吵架）。
 * @returns {boolean} 是否真的提交给了语音引擎
 */
function speakText(source) {
  if (!state.speechOn) return false;
  if (!speechSupported()) return false;

  const plain = stripMarkdownForSpeech(source);
  if (plain.length < 2) return false;

  const text = clipForSpeech(plain, SPEECH_MAX_CHARS);
  try {
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    const voice = pickChineseVoice();
    if (voice) {
      utter.voice = voice;
      utter.lang = voice.lang || 'zh-CN';
    } else {
      utter.lang = 'zh-CN';
    }
    utter.rate = SPEECH_RATE;
    utter.pitch = SPEECH_PITCH;
    utter.volume = 1;
    window.speechSynthesis.speak(utter);
    return true;
  } catch (err) {
    console.warn('[PromptPet] 语音播报失败：', err && err.message ? err.message : err);
    return false;
  }
}

function speechStatusText() {
  if (!state.speechOn) return '';
  if (!speechSupported()) return '这台机器没有语音引擎，开了也不会出声';
  return '';
}

function showSpeechStatus() {
  if (!speechStatus) return;
  speechStatus.textContent = speechStatusText();
  if (state.speechOn && !speechSupported()) speechStatus.dataset.kind = 'warn';
  else delete speechStatus.dataset.kind;
}

/** 应用语音开关（启动时 persist=false；用户改下拉框时 persist=true） */
function applySpeechSetting(on, options) {
  const opts = options || {};
  state.speechOn = Boolean(on);
  if (speechSelect) speechSelect.value = state.speechOn ? 'on' : 'off';
  if (opts.persist) writeSpeechOn(state.speechOn);
  // 关掉的一瞬间就要闭嘴 —— 不能等这句话念完
  if (!state.speechOn) cancelSpeech();
  showSpeechStatus();
  return state.speechOn;
}

/**
 * 应用剪贴板吐槽开关。
 * 关键点：关掉时要**通知主进程停表**，而不是「继续读、读到了丢掉」。
 */
function applyClipRoastSetting(on, options) {
  const opts = options || {};
  state.clipRoastOn = Boolean(on);
  if (clipSelect) clipSelect.value = state.clipRoastOn ? 'on' : 'off';
  if (opts.persist) writeClipRoastOn(state.clipRoastOn);
  if (api && typeof api.setClipboardWatch === 'function') {
    api.setClipboardWatch(state.clipRoastOn);
  }
  return state.clipRoastOn;
}

/** 随机挑一句，且不连着说同一句（连说两遍会显得很敷衍） */
let lastRoastLine = '';
function pickRoastLine(kind) {
  const pool = ROAST_LINES[kind] || ROAST_LINES.error;
  const choices = pool.filter((line) => line !== lastRoastLine);
  const list = choices.length ? choices : pool;
  const line = list[Math.floor(Math.random() * list.length)];
  lastRoastLine = line;
  return line;
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

/**
 * 状态行文案。
 * Phase 3.20 精简：下拉框自己就显示着当前档位，再写一遍「当前：极致 · reasoner ·
 * 210×315」纯属噪音（而且换行后两行挤在卡片里很乱）。这里只保留唯一需要解释的
 * 一件事 —— 这一档会不会把推理过程也展示出来。
 */
function defaultDepthText() {
  const d = DEPTHS[state.depth];
  return d.showReasoning ? '当前模型支持推理过程展示' : '直答模式，不展示推理过程';
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
// -----------------------------------------------------------------------------
// Phase 3.16：基础状态机
//   优先级从高到低：空中（甩飞）→ 睡眠 → 好感度分档
// -----------------------------------------------------------------------------

/** 当前表情对应的图片地址（按档位取表情包；脏值回落到 pot，永远不显示空图） */
function spriteSrcForFace(face, depth) {
  const d = depth || state.depth;
  const pack = FACE_PACKS[d] || PET_FACES;
  // 合法性看 PET_FACES：两套表情包共用同一组键（pot/idle/sad/sleep）
  const key = PET_FACES[face] ? face : FACE_POT;
  return pack[key] || pack[FACE_POT] || spriteSrcForDepth(d);
}

/** 档位自己的立绘（轻量走这条老路，和 Phase 3.15 完全一致） */
function spriteSrcForDepth(depth) {
  const d = DEPTHS[depth] || DEPTHS[DEFAULT_DEPTH] || DEPTHS.low;
  return d.src;
}

/** 这个档位是否启用四表情状态机 */
function usesFacePack(depth) {
  if (FACE_PACK_DEPTH === null) return true;
  const d = depth || state.depth;
  return Boolean(FACE_PACKS[d]);
}

/**
 * 「此刻该显示哪张图」的唯一答案。
 * 有表情包的档位交给表情，轻量档交给档位立绘 —— 两套规则永远不会同时生效，
 * 所以也就不存在抢 src 的问题。
 *
 * 唯一例外：轻量档没有表情包，但「欢呼」有单独的标准档差分。
 * 待办完成 / 番茄钟到点 / 牌局输赢都要让她自己举手，不能只弹字；
 * 这张图是方图，CSS 用 object-fit: contain 缩进轻量档画框即可。
 */
function currentSpriteSrc(face, depth) {
  // 待办完成窗口：强制用需求指定的 Q 版 / 九头身欢呼图，不随深度漂
  if (state.todoCheerSrc && nowMs() < state.todoCheerUntil) {
    return state.todoCheerSrc;
  }
  const next = face || state.face;
  if (usesFacePack(depth)) return spriteSrcForFace(next, depth);
  if (next === FACE_CHEER) return PET_FACES[FACE_CHEER];
  return spriteSrcForDepth(depth || state.depth);
}

/**
 * 唯一的换图入口。
 *
 * 为什么不能直接 `petSprite.src = xxx`：
 *   ① 解码是异步的，新图第一帧会露出空白（常驻窗口，这一闪非常显眼）；
 *   ② 连点切换时先后两次解码可能乱序完成，慢的那张会把新表情盖掉。
 * 所以这里做了三件事：判重、预解码、用自增序号丢弃过期结果。
 */
function setPetImage(src, options) {
  const opts = options || {};
  const target = String(src || '');
  if (!petSprite || !target) return Promise.resolve(false);
  if (state.faceSrc === target && opts.force !== true) return Promise.resolve(false);

  const seq = ++state.imageSeq;
  const commit = () => {
    // 期间又换过图：这次的结果已经过期，扔掉
    if (seq !== state.imageSeq) return false;
    state.faceSrc = target;
    petSprite.src = target;
    if (opts.animate && petSprite.classList) {
      // 同一张图连续切换时也要能重播：先摘掉类、强制重排、再加回去
      petSprite.classList.remove('face-swap');
      void petSprite.offsetWidth;
      petSprite.classList.add('face-swap');
    }
    return true;
  };

  // 测试环境 / 明确要求即时：不走预解码，直接换
  if (opts.instant === true || typeof Image !== 'function') {
    return Promise.resolve(commit());
  }
  return preloadSprite(target).then(commit);
}

/** 记一次「用户还在用」：点击、拖拽、发消息都会走到这里 */
function markActive() {
  state.lastActiveAt = nowMs();
}

/**
 * 把表情落到 DOM：图片 + 供 CSS/排查用的 dataset + 睡眠类名。
 * 真正「该显示哪张」由 updateBaseState 决定，这里只负责执行。
 */
function applyFace(face, options) {
  const opts = options || {};
  const next = PET_FACES[face] ? face : FACE_POT;
  const changed = next !== state.face;
  state.face = next;

  // 没有表情包的档位（轻量）：状态照样记录（切回标准 / 极致时立刻呈现正确表情），
  // 但视觉上只跟随档位，不挂睡眠类，也不做表情淡入。
  const pack = usesFacePack();
  const sleeping = pack && next === FACE_SLEEP;

  if (pet) {
    if (pet.dataset) pet.dataset.face = next;
    if (pet.classList) pet.classList.toggle('sleeping', sleeping);
  }
  if (typeof document !== 'undefined' && document.body && document.body.classList) {
    document.body.classList.toggle('pet-sleeping', sleeping);
  }

  // 换表情才做淡入；同一张图重复调用不折腾 DOM（非标准档会在这里被判重掉）
  setPetImage(currentSpriteSrc(next), {
    animate: pack && changed && opts.instant !== true,
    instant: opts.instant === true,
  });
}

/**
 * 重新算「现在该长什么样」。
 * 这是唯一决定表情的地方 —— 好感度变化、睡着、醒来、甩飞、落地都调它，
 * 不要在各处零散地换图，否则优先级一定会错。
 */
function updateBaseState(options) {
  const opts = options || {};

  // ① 被甩在空中：极致档换成「铁盆被扣在头上」的慌张差分，落地后再算。
  //    标准 / 轻量档没有 panic 这张图，applyFace() 内部查表回落到 pot，
  //    所以这里可以无条件传 panic，不用每档写分支。
  if (state.airborne) {
    applyFace(FACE_PANIC, opts);
    return state.face;
  }

  // ② Phase 3.24：待办完成的欢呼窗口压过牌局 / 番茄钟。
  //    用户刚勾掉一件，必须立刻看到桌宠本体的指定差分；
  //    到点后由 showCheer 的定时器重画，自动回到游戏 / 计时表情。
  if (state.todoCheerSrc && nowMs() < state.todoCheerUntil) {
    applyFace(FACE_CHEER, opts);
    return state.face;
  }
  if (state.todoCheerUntil && nowMs() >= state.todoCheerUntil) {
    state.todoCheerUntil = 0;
    state.todoCheerSrc = '';
  }

  // ③ Phase 3.22：牌桌排在番茄钟前面。
  //    她正在跟你比划，脸就该跟着输赢走；番茄钟还在跑的话，
  //    倒计时胶囊照常显示（phase 没变），只是表情归牌桌管。
  //    轻量档没有表情包，applyFace 内部会拦掉，只剩档位立绘 —— 与其它状态一致。
  if (state.game && state.game.active) {
    applyFace(state.game.face || FACE_POT, opts);
    return state.face;
  }

  // ④ Phase 3.23：番茄钟「专注结束」的欢呼窗口。
  //    主进程在时间到的那一刻就把 phase 翻成 resting 并推 done 事件，
  //    要是直接按 resting 画，她会在「时间到啦」同一帧变成抱枕 —— 完成感全没了。
  //    所以这里插一个几秒的窗口：压住休息表情，但**让位给新开的专注**
  //    （用户手快，结束三秒内又点了专注，那就该立刻是抱电脑的 code 脸）。
  if (
    state.cheerUntil &&
    nowMs() < state.cheerUntil &&
    state.pomodoro.phase !== POMO_FOCUS
  ) {
    applyFace(FACE_CHEER, opts);
    return state.face;
  }

  // ⑤ 番茄钟排在睡眠之前：专注时她正抱着笔记本陪你敲代码，
  //    这时候显示抱枕会非常出戏。休息同理 —— 番茄钟有自己的睡姿。
  //    ⚠️ 轻量档会在 applyFace 里被 usesFacePack 拦掉，只走档位立绘，
  //       所以这一段对轻量档是「只记录状态、不换图」，正是需求要的行为。
  const pomoFace = pomodoroFace();
  if (pomoFace) {
    applyFace(pomoFace, opts);
    return state.face;
  }

  // ⑥ 睡眠优先级高于心情：困了就是困了，不因为好感高而强撑
  let next;
  if (state.sleeping) {
    next = FACE_SLEEP;
  } else {
    const favor = clampFavor(state.favor);
    if (favor < FAVOR_SAD_BELOW) next = FACE_SAD;
    else if (favor < FAVOR_IDLE_BELOW) next = FACE_IDLE;
    else next = FACE_POT;
  }

  applyFace(next, opts);
  return state.face;
}

/**
 * 开一段「好耶」窗口（Phase 3.23）。
 *
 * 用**时间戳**而不是布尔 + 定时器来判定：常驻窗口会被系统节流，
 * 一旦复位定时器迟到，布尔值就会把她永久卡在举手状态。
 * 定时器在这里只是「到点主动重画一次」，即使它晚了，下一次任何
 * updateBaseState 也会按 cheerUntil 自动回到正确表情。
 */
function showCheer(ms) {
  const span = Number(ms) > 0 ? Number(ms) : POMO_CHEER_MS;
  state.cheerUntil = nowMs() + span;
  if (state.cheerTimer && typeof clearTimeout === 'function') {
    clearTimeout(state.cheerTimer);
  }
  state.cheerTimer = 0;
  if (typeof setTimeout === 'function') {
    state.cheerTimer = setTimeout(() => {
      state.cheerTimer = 0;
      state.cheerUntil = 0;
      updateBaseState();
    }, span);
  }
  updateBaseState();
}

/** 立刻结束欢呼窗口（手动停止番茄钟 / 立刻开下一轮专注时用） */
function clearCheer() {
  state.cheerUntil = 0;
  state.todoCheerUntil = 0;
  state.todoCheerSrc = '';
  if (state.cheerTimer) {
    if (typeof clearTimeout === 'function') clearTimeout(state.cheerTimer);
    state.cheerTimer = 0;
  }
}

/** 入睡：只改状态，具体长什么样交给 updateBaseState */
function enterSleep() {
  if (state.sleeping) return false;
  state.sleeping = true;
  updateBaseState();
  return true;
}

/** 醒来：立刻改状态并重新算表情；返回是否真的从睡眠中醒来 */
function wakeUp() {
  markActive(); // 醒来的这一刻重新计时，否则巡检下一秒又把她哄睡
  if (!state.sleeping) return false;
  state.sleeping = false;
  updateBaseState();
  return true;
}

/**
 * 睡眠巡检（每秒一次）。
 * 抽成独立函数而不是塞在 setInterval 里，是因为单测里没有 setInterval，
 * 需要能直接手动触发一次「时间到了」。
 */
function checkSleepDeadline() {
  // 没有表情包的档位（轻量）没有睡眠这回事（保持改动前的行为）
  if (!usesFacePack()) return false;
  if (state.sleeping) return false;
  // 番茄钟进行中不睡：她正在「专注」或「休息」，两种都有专属表情，
  // 再叠一层 60 秒自动睡眠只会把表情抢走。
  if (state.pomodoro.phase !== POMO_IDLE) return false;
  // Phase 3.22：牌局进行中不睡 —— 她正盯着你出拳，睡着就没法玩了
  if (state.game && state.game.active) return false;
  // 正在拖 / 正在飞 / 正在等回答，都不算「闲着」，不该睡
  if (state.airborne || press.active || fling.active || state.dragging) return false;
  if (state.sending) return false;
  if (nowMs() - state.lastActiveAt < SLEEP_AFTER_MS) return false;
  return enterSleep();
}

function startSleepWatch() {
  stopSleepWatch();
  if (typeof setInterval !== 'function') return; // 测试沙箱里没有，跳过
  state.sleepTimer = setInterval(checkSleepDeadline, 1000);
}

function stopSleepWatch() {
  if (!state.sleepTimer) return;
  if (typeof clearInterval === 'function') clearInterval(state.sleepTimer);
  state.sleepTimer = 0;
}

// -----------------------------------------------------------------------------
// Phase 3.18：番茄钟（渲染侧）
//
// 职责边界很清楚：
//   · 主进程 = 唯一的时间来源（phase / remainingMs / totalMs）；
//   · 渲染进程 = 把快照画出来 + 决定「长什么样」。
// 所以这里没有任何 Date.now() 的倒计时运算 —— 只有一个格式化函数。
// -----------------------------------------------------------------------------

/** 剩余毫秒 → "24:59"。用 ceil：1 秒整时显示 00:01，落到 0 才显示 00:00 */
function formatClock(ms) {
  const total = Math.max(0, Math.ceil(Number(ms) / 1000) || 0);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

/** 番茄钟此刻该用哪个表情；没有在计时就返回 null（交回睡眠 / 好感度） */
function pomodoroFace() {
  const phase = state.pomodoro.phase;
  if (phase === POMO_FOCUS) return FACE_CODE;
  if (phase === POMO_REST) return FACE_SLEEP;
  return null;
}

/** 把脏快照洗成合法值 —— 主进程理论上不会给错，但渲染进程不该信任输入 */
function normalizeSnapshot(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const phase =
    src.phase === POMO_FOCUS || src.phase === POMO_REST ? src.phase : POMO_IDLE;
  const totalMs = Number(src.totalMs);
  const remainingMs = Number(src.remainingMs);
  return {
    phase,
    totalMs: Number.isFinite(totalMs) && totalMs > 0 ? totalMs : 0,
    remainingMs: Number.isFinite(remainingMs) && remainingMs > 0 ? remainingMs : 0,
  };
}

/** 画小胶囊：文本 + 显隐 + 位置。每秒只改 textContent，不碰图片 */
function renderPomoChip() {
  if (!pomoChip) return;

  const { phase, remainingMs } = state.pomodoro;
  if (phase === POMO_IDLE) {
    if (pomoChip.classList) pomoChip.classList.remove('is-on');
    pomoChip.setAttribute('aria-hidden', 'true');
    // 顺手把文案清掉：不然读屏 / 调试面板里会留着一个早已结束的「专注中 00:00」
    if (pomoChipText && pomoChipText.textContent !== '') {
      pomoChipText.textContent = '';
    }
    return;
  }

  const clock = formatClock(remainingMs);
  const text =
    phase === POMO_FOCUS ? `⏳ 专注中 ${clock}` : `☕ 休息中 ${clock}`;
  if (pomoChipText && pomoChipText.textContent !== text) {
    pomoChipText.textContent = text;
  }
  // data-phase 给 CSS 用：休息是暖色，专注是深色
  pomoChip.setAttribute('data-phase', phase);
  pomoChip.setAttribute('aria-hidden', 'false');
  if (pomoChip.classList) pomoChip.classList.add('is-on');

  // 文本长度会变（25:00 → 24:59 宽度不变，但「专注中」→「休息中」会变），
  // 所以每次显示都重新量一次，否则胶囊会偏一点。
  if (pomoChip.offsetWidth) {
    state.pomoChipSize = {
      w: pomoChip.offsetWidth,
      h: pomoChip.offsetHeight,
    };
  }
  positionPomoChip();
}

/**
 * 小胶囊定位：默认在角色头顶正中。
 *
 * 关键约束是「不许挡住聊天对话框」：
 *   聊天气泡默认也在角色上方（data-arrow="down"），两者会撞在一起。
 * 所以气泡一打开，胶囊就自动躲到角色脚下；气泡翻到下方时再回到头顶。
 * 最后统一钳制进屏幕，避免贴边被裁。
 */
function positionPomoChip() {
  if (!pomoChip || state.pomodoro.phase === POMO_IDLE) return;

  const { w, h } = state.pomoChipSize;
  if (!w || !h) return;

  const box = state.box;
  const bounds = state.bounds;
  const maxX = Math.max(0, bounds.width - w);

  // 立绘常态是 scale(1.1)（见 style.css 的 .pet-sprite），真正画出来的角色
  // 比画框上下各高出约 5%。胶囊要贴的是「画出来的角色」，不是画框 ——
  // 否则让到脚下时会正好压在小腿 / 尾巴上（真机截图里看得一清二楚）。
  const bleed = Math.round((box.h * 0.1) / 2);
  const headY = state.pos.y - bleed - h - POMO_CHIP_GAP;
  const footY = state.pos.y + box.h + bleed + POMO_CHIP_GAP;

  let x = state.pos.x + box.w / 2 - w / 2;
  let y = headY; // 头顶

  // 气泡开着且位于角色上方 → 让到脚下
  const bubbleAbove =
    state.bubbleOpen && bubble && bubble.getAttribute('data-arrow') !== 'up';
  if (bubbleAbove) y = footY;

  // 上方空间不够（贴着屏幕上沿）就翻到脚下
  if (y < 0) y = footY;
  // 脚下也放不下（贴地）就回到上方并钳制
  if (y + h > bounds.height) {
    y = Math.max(0, Math.min(headY, bounds.height - h));
  }

  x = Math.min(Math.max(0, x), maxX);
  pomoChip.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
}

/**
 * 应用一份主进程快照。
 *
 * 只有 **phase 变化** 才重算表情：
 *   每秒 tick 都调 updateBaseState 的话，会每秒走一次 setPetImage（虽然会被判重），
 *   而且轻量档会白白多出 60 次/分的 DOM 读写。
 */
function applyPomodoroSnapshot(raw) {
  const prevPhase = state.pomodoro.phase;
  state.pomodoro = normalizeSnapshot(raw);

  renderPomoChip();

  if (state.pomodoro.phase === prevPhase) return;

  // 立刻开始下一轮专注：欢呼窗口作废，别让 code 表情迟到三秒。
  // 放在 wakeUp 之前，wakeUp 里的 updateBaseState 就能拿到干净的状态。
  if (state.pomodoro.phase === POMO_FOCUS) clearCheer();

  // 开始专注 / 休息 = 她醒着：「睡着了」这个状态必须先清掉，
  // 否则番茄钟结束后会立刻倒回抱枕（60 秒睡眠计时早就过了）。
  if (state.pomodoro.phase !== POMO_IDLE) {
    wakeUp();
  }

  updateBaseState();
}

/**
 * 大号对话框：复用 #bubble，加 .bubble--big 放大。
 *
 * 为什么不新开一个元素：气泡的定位 / 尾巴 / 淡入 / 命中检测都已经调好了，
 * 再复制一份必然出现「新气泡点不动」这类问题。
 * 宽度变了必须重新 measureBubble()，否则 positionBubble 会按旧宽度摆。
 */
function showBigDialog(text) {
  // Phase 3.22：牌局进行中不抢面板。
  // 猜拳本来就占着气泡，这里硬切到聊天页会把牌桌整块藏起来（状态还在，
  // 但玩家看不见也点不到，只能等下次进来「继续」——那是 bug 不是功能）。
  // 所以改走「记进聊天记录」：点【不玩了】回到聊天页就能看到这句提醒。
  if (state.game && state.game.active) {
    appendMessage('assistant', text, { plain: true, copy: false });
    return false;
  }

  if (state.panel !== 'chat') setPanel('chat');
  if (!state.bubbleOpen) openBubble();

  appendMessage('assistant', text, { plain: true, copy: false });

  if (bubble && bubble.classList) bubble.classList.add('bubble--big');
  if (state.bigDialogTimer) clearTimeout(state.bigDialogTimer);
  if (typeof setTimeout === 'function') {
    state.bigDialogTimer = setTimeout(() => {
      state.bigDialogTimer = 0;
      if (bubble && bubble.classList) bubble.classList.remove('bubble--big');
      relayoutBubble();
      // 缩回正常大小后气泡变窄，重新摆一次位置
      if (state.bubbleOpen) positionBubble();
    }, POMO_BIG_DIALOG_MS);
  }

  // 加类之后宽度变了，先量再摆
  relayoutBubble();

  // 提醒必须能看见：把窗口提到前面（并让气泡拿到焦点，读屏也能念出来）
  if (api && api.focusWindow) api.focusWindow();
  if (bubbleLog) bubbleLog.scrollTop = bubbleLog.scrollHeight;
}

/**
 * 一轮结束的回调（主进程推送）。
 * 专注结束 → 说那句指定台词；此时主进程已经自动进入 resting，
 * 所以表情会跟着变成睡姿（轻量档除外）。
 */
function onPomodoroDone(payload) {
  const data = payload && typeof payload === 'object' ? payload : {};
  applyPomodoroSnapshot(data);

  if (data.finished === POMO_FOCUS) {
    // 先举手欢呼，再把那句「时间到啦」说出来（Phase 3.23 需求）
    showCheer(POMO_CHEER_MS);
    showBigDialog(POMO_DONE_FOCUS_LINE);
  } else if (data.finished === POMO_REST) {
    showBigDialog(POMO_DONE_REST_LINE);
  }
}

/** 开始一轮。失败（比如浏览器预览里没有主进程）时给一句人话，不静默 */
async function startPomodoro(phase) {
  if (!api || typeof api.pomodoroStart !== 'function') {
    if (!state.bubbleOpen) openBubble();
    appendMessage('notice', '番茄钟要在桌面应用里才跑得起来（这里没有主进程）。');
    return;
  }
  try {
    const snap = await api.pomodoroStart(phase === POMO_REST ? POMO_REST : POMO_FOCUS);
    applyPomodoroSnapshot(snap);
    // 手动开休息也要有个交代，否则点了菜单只是头顶多了个小胶囊
    if (phase === POMO_REST) {
      if (!state.bubbleOpen) openBubble();
      appendMessage('assistant', '（把抱枕拍松） 行吧，先眯五分钟。', {
        plain: true,
        copy: false,
      });
    }
  } catch (err) {
    console.warn('[PromptPet] 番茄钟启动失败：', err);
  }
}

async function stopPomodoro() {
  if (!api || typeof api.pomodoroStop !== 'function') return;
  try {
    const snap = await api.pomodoroStop();
    // 手动停止是「放弃」，不是「完成」—— 不能顺手给她发个欢呼
    clearCheer();
    applyPomodoroSnapshot(snap);
  } catch (err) {
    console.warn('[PromptPet] 番茄钟停止失败：', err);
  }
}

/** 订阅主进程推送 + 首屏拉一次状态（窗口重开也能续上） */
function bindPomodoroEvents() {
  if (!api) return;

  if (typeof api.onPomodoroTick === 'function') {
    api.onPomodoroTick((snapshot) => applyPomodoroSnapshot(snapshot));
  }
  if (typeof api.onPomodoroDone === 'function') {
    api.onPomodoroDone((payload) => onPomodoroDone(payload));
  }
  if (typeof api.pomodoroState === 'function') {
    Promise.resolve(api.pomodoroState())
      .then((snap) => applyPomodoroSnapshot(snap))
      .catch(() => {
        /* 拿不到就当 idle，不影响其它功能 */
      });
  }
}

// -----------------------------------------------------------------------------
// Phase 3.18：右键菜单
//
// 以前右键 = 直接查余额。现在一个右键要承载「专注 / 休息 / 停止 / 余额 / 设置」，
// 必须升级成菜单。实现要点：
//   ① 必须算进「可交互区域」，否则鼠标穿透会让按钮点不动（见 isPointInteractive）；
//   ② 打开时把焦点给第一项，键盘能直接上下选（桌宠是常驻窗口，键盘可达性很要紧）；
//   ③ 任何一次「点别处 / ESC / 失焦 / 拖拽」都要关掉，否则菜单会飘在桌面上。
// -----------------------------------------------------------------------------

function openPetMenu(x, y) {
  if (!petMenu) return;

  state.menuOpen = true;
  if (petMenu.classList) petMenu.classList.add('is-open');
  petMenu.setAttribute('aria-hidden', 'false');

  // Phase 3.22：先按下锁定态，再量尺寸 —— 顶部那行提示会改变菜单高度，
  // 顺序反了就会出现「菜单比命中框高一截，最后一项点不动」。
  lockMenuForGame();

  const w = petMenu.offsetWidth || 148;
  const h = petMenu.offsetHeight || 180;
  state.menuSize = { w, h };

  // 默认出现在鼠标右下方；右侧 / 底边放不下就翻到另一侧，保证整块菜单可见
  let mx = x + 2;
  let my = y + 2;
  if (mx + w > state.bounds.width) mx = Math.max(0, x - w - 2);
  if (my + h > state.bounds.height) my = Math.max(0, y - h - 2);

  state.menuPos = { x: mx, y: my };
  petMenu.style.transform = `translate3d(${Math.round(mx)}px, ${Math.round(my)}px, 0)`;

  // 菜单可交互：立刻关掉穿透，否则鼠标移上去是「点桌面」
  setIgnoreMouse(false);

  // 键盘可达性：把焦点给第一项，Tab / 方向键就能直接选（单测的 mock 元素没有
  // querySelector，所以先做能力检测，不能想当然）
  const first =
    typeof petMenu.querySelector === 'function'
      ? petMenu.querySelector('.pet-menu-item:not(:disabled)') ||
        petMenu.querySelector('.pet-menu-item')
      : null;
  if (first && typeof first.focus === 'function') first.focus({ preventScroll: true });
}

function closePetMenu() {
  if (!state.menuOpen || !petMenu) return;
  state.menuOpen = false;
  if (petMenu.classList) petMenu.classList.remove('is-open');
  petMenu.setAttribute('aria-hidden', 'true');

  const active = document.activeElement;
  if (
    active &&
    typeof petMenu.contains === 'function' &&
    petMenu.contains(active) &&
    typeof active.blur === 'function'
  ) {
    active.blur();
  }

  // 关掉之后指针可能已经不在球上，重新判定穿透
  refreshIgnore();
}

/** 菜单项动作。每个动作都以「先关菜单」开头 —— 否则菜单会盖在结果上 */
function handlePetMenuAction(action) {
  closePetMenu();

  // Phase 3.22：牌局进行中只放行「停止计时」。
  // 菜单项已经置灰了，这里是第二道闸 —— 键盘触发 / 程序触发都绕不过去。
  if (state.game && state.game.active && action !== 'pomodoro-stop') return;

  if (action === 'pomodoro-focus') {
    startPomodoro(POMO_FOCUS);
    return;
  }
  if (action === 'pomodoro-rest') {
    startPomodoro(POMO_REST);
    return;
  }
  if (action === 'pomodoro-stop') {
    stopPomodoro();
    return;
  }
  if (action === 'game') {
    enterGame();
    return;
  }
  // Phase 3.25：待办是 #bubble 的第五个视图，不再另开悬浮面板
  if (action === 'todo') {
    toggleTodoPanel();
    return;
  }
  // Phase 3.27：天气页（同一个菜单项负责显示 / 隐藏）
  if (action === 'weather') {
    toggleWeatherPanel();
    return;
  }
  if (action === 'wallet') {
    refreshBalance();
    return;
  }
  if (action === 'settings') {
    if (!state.bubbleOpen) openBubble();
    setPanel('settings');
    relayoutBubble();
  }
}

/**
 * 点空白处 / 键盘 Tab 出去 / 失焦都要收起菜单。
 * ⚠️ 用 mousedown 而不是 click：click 在 mouseup 之后，
 *    那时菜单项已经被「关菜单」逻辑藏起来了，点击永远落空。
 *    菜单内部的 mousedown 直接放行（交给按钮自己的 click）。
 */
function onDocumentMouseDown(event) {
  if (!state.menuOpen) return;
  if (
    petMenu &&
    typeof petMenu.contains === 'function' &&
    petMenu.contains(event && event.target)
  ) {
    return;
  }
  closePetMenu();
}

/**
 * 被戳醒时的台词。
 * 走到这里说明「睡着了 + 点了一下」，所以顺手把气泡打开：
 * 否则用户戳一下只会看到气泡关闭，等于白叫一声。
 * 5 秒冷却：连点不会刷出一屏「干嘛吵醒我」。
 */
function showWakeLine() {
  if (state.panel !== 'chat') setPanel('chat');
  if (!state.bubbleOpen) openBubble();
  // 0 表示「还没说过」——不能用 nowMs() 直接相减：
  // 页面刚加载时 performance.now() 本身就只有几秒，会把第一句误判成冷却中。
  if (state.wakeLineAt !== 0 && nowMs() - state.wakeLineAt < WAKE_LINE_COOLDOWN_MS) {
    return;
  }
  state.wakeLineAt = nowMs();
  appendMessage('assistant', WAKE_LINE, { plain: true, copy: false });
}

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
  //    这里绕开 setPetImage 直接写，是因为此刻元素已经在暗场，
  //    再做「解码后淡入」反而会多一段等待；只需把 faceSrc 同步对。
  //    取「此刻应该显示的表情」而不是入参：淡出这 380ms 里好感度可能刚好变了
  //    （比如刚发完一条消息），写回旧图会让状态机和画面从此对不上。
  if (petSprite) {
    const shown = currentSpriteSrc() || nextSrc;
    state.faceSrc = shown;
    petSprite.src = shown;
  }
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

  /** 状态行文案：只交代「已生效并记住」，模型名和画框尺寸不再重复（Phase 3.20） */
  const showApplied = () => {
    showDepthStatus(DEPTHS[next].showReasoning ? '已记住 · 会展示推理过程' : '已记住', 'ok');
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
    // 标准档换的是「同一张表情」的新画框；轻量 / 极致换的是各自的档位立绘。
    // 两种情况都交给 currentSpriteSrc() 决定，这里不写死任何一张图。
    void runMorph(currentSpriteSrc(), () => {
      applyBox();
      // 动画期间已经写过盘，这里只更新界面：
      // 状态行等新立绘「亮相」那一刻再变，避免文字先于画面上新。
      syncDepthControls();
      if (opts.persist) showApplied();
    });
  } else {
    // 同上：标准档保持当前表情，轻量 / 极致换成档位立绘
    setPetImage(currentSpriteSrc(), { instant: true });
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
  // 气泡高度变了会重新翻边（上/下），胶囊跟着换边
  positionPomoChip();
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
    // Phase 3.20：一句话说完「存了什么」+「怎么改」，不再啰嗦「点保存可以换一张」
    showKeyStatus(`已保存：${maskKey(key)}（输入新 Key 可覆盖）`, 'ok');
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
  if (state.panel === 'todo') {
    // 待办页打开就落在输入框：右键 → 呼出 → 直接打字，少一次点击。
    if (bubbleInput && document.activeElement === bubbleInput) bubbleInput.blur();
    if (todoInput && typeof todoInput.focus === 'function') {
      try {
        todoInput.focus({ preventScroll: true });
      } catch (err) {
        todoInput.focus();
      }
    }
    return;
  }
  if (state.panel === 'weather') {
    // 天气页没有输入框：把焦点从聊天框上摘掉，同时收起输入法。
    if (bubbleInput && document.activeElement === bubbleInput) bubbleInput.blur();
    setImeFriendly(false);
    return;
  }
  if (state.panel === 'settings') {
    if (keyInput) keyInput.focus();
  } else if (state.panel === 'game') {
    // 牌桌没有输入框：把焦点从聊天框上摘掉（顺便收输入法），
    // 再落到第一张手牌上 —— 键盘用户按回车就能出拳，手感比 Tab 三次好得多。
    if (bubbleInput && document.activeElement === bubbleInput) bubbleInput.blur();
    setImeFriendly(false);
    const firstHand =
      gameHands && typeof gameHands.querySelector === 'function'
        ? gameHands.querySelector('.game-hand')
        : null;
    if (firstHand && typeof firstHand.focus === 'function') {
      firstHand.focus({ preventScroll: true });
    }
  } else if (state.panel === 'wallet') {
    // 钱包视图没有输入框：把焦点从聊天框上摘掉，顺便收起输入法
    if (bubbleInput && document.activeElement === bubbleInput) bubbleInput.blur();
    setImeFriendly(false);
  } else if (bubbleInput) {
    bubbleInput.focus();
  }
}

/** 切换「聊天 / 待办 / 天气 / 设置 / 钱包 / 猜拳」六个视图 */
function setPanel(name) {
  state.panel =
    name === 'todo'
      ? 'todo'
      : name === 'weather'
        ? 'weather'
        : name === 'settings'
          ? 'settings'
          : name === 'wallet'
            ? 'wallet'
            : name === 'game'
              ? 'game'
              : 'chat';

  const isChat = state.panel === 'chat';
  const isTodo = state.panel === 'todo';
  const isWeather = state.panel === 'weather';

  if (viewChat) viewChat.hidden = !isChat;
  if (viewTodo) viewTodo.hidden = !isTodo;
  if (viewWeather) viewWeather.hidden = !isWeather;
  if (viewSettings) viewSettings.hidden = state.panel !== 'settings';
  if (viewWallet) viewWallet.hidden = state.panel !== 'wallet';
  if (viewGame) viewGame.hidden = state.panel !== 'game';

  // CSS 用 data-panel 给待办 / 天气页换皮肤；页签在聊天 / 待办 / 天气之间出现。
  if (bubble) {
    bubble.dataset.panel = state.panel;
    bubble.classList.toggle('bubble--todo', isTodo);
    bubble.classList.toggle('bubble--weather', isWeather);
  }
  const tabsVisible = isChat || isTodo || isWeather;
  if (bubbleTabs) bubbleTabs.hidden = !tabsVisible;
  if (bubbleTabChat) {
    bubbleTabChat.classList.toggle('is-active', isChat);
    bubbleTabChat.setAttribute('aria-selected', isChat ? 'true' : 'false');
  }
  if (bubbleTabTodo) {
    bubbleTabTodo.classList.toggle('is-active', isTodo);
    bubbleTabTodo.setAttribute('aria-selected', isTodo ? 'true' : 'false');
  }
  if (bubbleTabWeather) {
    bubbleTabWeather.classList.toggle('is-active', isWeather);
    bubbleTabWeather.setAttribute('aria-selected', isWeather ? 'true' : 'false');
  }

  // 齿轮只属于聊天页 / 设置页：牌桌有 [X]，待办 / 天气页有页签和 [X]；
  // 再并排一个齿轮会让人以为它也能「关掉」当前页。
  if (bubbleGear) bubbleGear.hidden = state.panel === 'game' || isTodo || isWeather;

  if (bubbleTitle) {
    bubbleTitle.textContent =
      isTodo
        ? '待办事项'
        : isWeather
          ? '今日天气'
          : state.panel === 'settings'
            ? '设置'
            : state.panel === 'game'
              ? '猜拳 · 不许赖账'
              : '吃白饭的大肥鱼';
  }

  // 待办 / 天气的开合 = 气泡开着且当前页就是它；右键菜单文案跟着走。
  state.todoOpen = Boolean(state.bubbleOpen && isTodo);
  state.weatherOpen = Boolean(state.bubbleOpen && isWeather);
  // 切走天气页就顺手把地区浮层收掉，免得下次进来它还开着
  if (!isWeather) closeWeatherLocPanel();
  setMenuTodoLabel();
  setMenuWeatherLabel();
  if (!isTodo) clearTodoSay();

  if (state.panel === 'settings') {
    refreshKeyStatus();
    updateMemoryStatus();
    // 每次进设置页都把下拉框对齐到「真正生效的档位」——
    // 万一上次存盘失败、或者有人手动改了 localStorage，这里能自动纠正显示
    syncDepthControls();
    if (speechSelect) speechSelect.value = state.speechOn ? 'on' : 'off';
    if (clipSelect) clipSelect.value = state.clipRoastOn ? 'on' : 'off';
  } else if (state.panel === 'chat') {
    setTag(state.sending ? '正在思考…' : TAG_HINT, state.sending ? 'busy' : null);
  }

  fitSettingsHeight();
  relayoutBubble(); // 六个视图高度不同，必须重新量、重新摆
  focusPanel();
}

/**
 * Phase 3.21：给设置页封顶。
 *
 * 加了「声音与提醒」之后设置页高到 ≈600px，而角色上方通常只有 ≈490px ——
 * 气泡会翻到角色下面，把整只鲸鱼盖住（positionBubble 的 clamp 也救不了）。
 * 所以进设置页时按「角色头顶到屏幕顶」算一次可用高度，超出就在视图内部滚动。
 * 只在设置页生效：聊天页的高度本来就是靠 .bubble-log 自己滚的。
 */
function fitSettingsHeight() {
  if (!viewSettings) return;
  if (state.panel !== 'settings') {
    viewSettings.style.maxHeight = '';
    return;
  }
  // 气泡总高 = 标题栏 + 内边距 + 视图高度。封顶要作用在「视图」上，
  // 所以先把外壳（标题栏 + 上下 padding）扣掉，否则气泡还是会比可用空间高几十像素，
  // 照样压到角色身上。外壳高度与内容无关，量一次即可。
  const bubbleH = bubble ? bubble.offsetHeight || 0 : 0;
  const viewH = viewSettings.offsetHeight || 0;
  // 量不到布局时（隐藏中、测试环境）按 72px 兜底：标题栏 + 上下 padding 的实测值
  const chrome = bubbleH > viewH ? bubbleH - viewH : 72;
  // 留 16px 给气泡下沿的间距，避免贴着角色头顶（那 14px 是箭头的位置）
  const available = Math.round(state.pos.y - BUBBLE_GAP - 2 - chrome);
  // 下限 280：屏幕实在太小的时候宁可溢出，也不要把设置页压成一条缝
  viewSettings.style.maxHeight = `${Math.max(280, available)}px`;
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
  if (!event || event.key !== 'Escape') return;

  // 菜单优先：ESC 先收菜单，再管地区面板 / 待办，最后管气泡
  if (state.menuOpen) {
    event.preventDefault();
    closePetMenu();
    return;
  }

  // Phase 3.28：地区选择浮层比天气页更靠上一层，ESC 先收它。
  if (state.weatherLocOpen) {
    event.preventDefault();
    closeWeatherLocPanel();
    return;
  }

  // Phase 3.25：待办是气泡的一个视图；Esc 先收它 = 收起整个对话框。
  // 待办页没开时完全不改变原有行为。
  if (state.todoOpen) {
    event.preventDefault();
    closeTodoPanel();
    return;
  }

  if (!state.bubbleOpen) return;
  event.preventDefault();
  if (state.panel === 'settings') {
    setPanel('chat');
    return;
  }
  // Phase 3.22：牌桌上的 ESC =「不玩了」（回聊天），不是「连气泡一起收掉」——
  // 和设置页同一个心智：先退一层，再退一层。
  if (state.panel === 'game') {
    endGame(true);
    return;
  }
  closeBubble();
}

// -----------------------------------------------------------------------------
// Phase 3.22：猜拳（逻辑 + 视图）
//
// 结构上是「一个视图 + 一台很笨的状态机」：
//   出拳前：.game-hands 显示，.game-actions 隐藏
//   出拳后：反过来，并把判定文字 / 台词 / 表情 / 好感度一次算完
// 没有网络、没有计时器、没有异步 —— 所以整套逻辑是同步的，
// 可以在单测里直接 playRound('rock') 然后断言结果。
// -----------------------------------------------------------------------------

/** 她出什么。真随机：不预测、不补偿连败，玩家也就无从「背规律」 */
function randomGameHand() {
  const index = Math.floor(Math.random() * GAME_HANDS.length);
  return GAME_HANDS[index] || GAME_HANDS[0];
}

/** 判定：'win' = 玩家赢，'lose' = 玩家输，'draw' = 平 */
function judgeGame(playerHand, fishHand) {
  if (playerHand === fishHand) return 'draw';
  return GAME_BEATS[playerHand] === fishHand ? 'win' : 'lose';
}

/** 比分行文案。一局都没打的时候显示邀请语，而不是「0 胜 0 负 0 平」 */
function gameScoreText() {
  const g = state.game;
  if (!g.round) return '出拳吧，本小姐让你先';
  const parts = [];
  if (g.wins) parts.push(`${g.wins} 胜`);
  if (g.losses) parts.push(`${g.losses} 负`);
  if (g.draws) parts.push(`${g.draws} 平`);
  return `第 ${g.round} 局 · ${parts.join(' ')}`;
}

/** 把比分画到标题行；data-kind 让赢/输的比分带一点颜色（CSS 里只有这两档） */
function renderGameScore() {
  if (!gameScore) return;
  gameScore.textContent = gameScoreText();
  if (state.game.last) {
    gameScore.dataset.kind = state.game.last;
  } else {
    delete gameScore.dataset.kind;
  }
}

/** 手牌区 / 结果按钮二选一。两者高度一致（CSS 钉了 min-height），切换时面板不抽动 */
function renderGameState() {
  const over = Boolean(state.game.over);
  if (gameHands) gameHands.hidden = over;
  if (gameActions) gameActions.hidden = !over;
}

/**
 * 好感度加减。
 * 刻意**不**走 settleFavorForMessage：那条路会写记忆、弹提示，
 * 属于「聊天」的语义；猜拳只是悄悄加减一个数字。
 */
function bumpGameFavor(delta) {
  const amount = Number(delta) || 0;
  if (!amount) return state.favor;
  state.favor = clampFavor(clampFavor(state.favor) + amount);
  writeFavor(state.favor);
  return state.favor;
}

/**
 * 出拳 —— 整个游戏唯一会改变结果的地方。
 * 返回本局判定（'win' | 'lose' | 'draw'），没在牌桌上时返回 null。
 */
function playRound(playerHand) {
  const g = state.game;
  if (!g.active || g.over) return null;
  if (!GAME_HAND_LABEL[playerHand]) return null;

  const fishHand = randomGameHand();
  const verdict = judgeGame(playerHand, fishHand);

  g.round += 1;
  if (verdict === 'win') g.wins += 1;
  else if (verdict === 'lose') g.losses += 1;
  else g.draws += 1;

  g.last = verdict;
  g.over = true;
  g.face = GAME_FACE[verdict] || FACE_POT;

  bumpGameFavor(GAME_FAVOR[verdict]);

  const line = GAME_LINES[verdict] || '';
  if (gameMoves) {
    gameMoves.textContent =
      `你出了[${GAME_HAND_LABEL[playerHand]}]，本小姐出了[${GAME_HAND_LABEL[fishHand]}]`;
  }
  if (gameLine) gameLine.textContent = line;

  renderGameScore();
  renderGameState();

  // 表情跟着输赢走（win 不服气 / lose 得意 / draw 死鱼眼）
  updateBaseState();
  // 开了语音就念出来；没开 speakText 自己会返回 false，不用在这里判开关
  speakText(line);

  // 只重量、不重摆：文字换行可能让面板高出一两个像素，
  // 不更新缓存的话「再来一局」的下沿会落在命中框外。而重新摆会让她在桌面上跳一下。
  measureBubble();
  return verdict;
}

/** 进牌桌：重置比分，打开气泡并切到游戏视图 */
function enterGame() {
  const g = state.game;
  g.active = true;
  g.round = 0;
  g.wins = 0;
  g.losses = 0;
  g.draws = 0;
  g.last = '';
  g.over = false;
  g.face = FACE_POT; // 等你出拳的时候是「铁盆脸」，不是上一局的余味

  if (gameMoves) gameMoves.textContent = '';
  if (gameLine) gameLine.textContent = '';

  // 玩也是交互：不刷新 lastActiveAt 的话，玩了 60 秒她会当场睡着
  markActive();

  if (!state.bubbleOpen) openBubble();
  setPanel('game');
  renderGameScore();
  renderGameState();
  updateBaseState();
}

/** 【再来一局】：只把「已出结果」翻回去，比分继续累计 */
function nextGameRound() {
  const g = state.game;
  if (!g.active) {
    enterGame();
    return;
  }

  g.over = false;
  g.last = '';
  g.face = FACE_POT;
  if (gameMoves) gameMoves.textContent = '';
  if (gameLine) gameLine.textContent = '';

  renderGameState();
  renderGameScore();
  updateBaseState();
  measureBubble();
  focusPanel();
}

/**
 * 退出牌局。
 * showChat = true 时顺手切回聊天页（点 ✕ / 不玩了 / ESC 都走这条）；
 * false 只清状态，留给 resetGameView 在「气泡正在关闭」时用 ——
 * 那种情况下再 setPanel 会触发 measure/position，量到的全是 0。
 * 返回是否真的结束了一局（调用方据此决定要不要重算表情）。
 */
function endGame(showChat) {
  const g = state.game;
  const wasPlaying = g.active || g.over;

  g.active = false;
  g.over = false;
  g.last = '';
  g.face = '';

  if (gameMoves) gameMoves.textContent = '';
  if (gameLine) gameLine.textContent = '';
  if (gameHands) gameHands.hidden = false;
  if (gameActions) gameActions.hidden = true;

  if (wasPlaying) updateBaseState();

  if (showChat && state.bubbleOpen) setPanel('chat');
  return wasPlaying;
}

/**
 * 从牌桌静默退回聊天视图 —— 只改显示，不量不摆。
 * 用在 closeBubble 里，理由和 resetWalletView 完全相同：
 * 气泡已经藏起来了，这时候 measureBubble 只能量到 0。
 */
function resetGameView() {
  if (state.panel !== 'game') return false;
  state.panel = 'chat';
  endGame(false);
  if (viewChat) viewChat.hidden = false;
  if (viewSettings) viewSettings.hidden = true;
  if (viewWallet) viewWallet.hidden = true;
  if (viewGame) viewGame.hidden = true;
  if (bubbleTitle) bubbleTitle.textContent = '吃白饭的大肥鱼';
  if (bubbleGear) bubbleGear.hidden = false;
  return true;
}

/**
 * 牌局进行中把菜单里「会打断牌局」的项置灰。
 * 只留「停止计时」：它是安全阀 —— 番茄钟是别人的时间，不该被牌局困住。
 * ⚠️ 单测的 mock 元素没有 querySelectorAll，所以先做能力检测。
 */
function lockMenuForGame() {
  if (!petMenu) return;
  const locked = Boolean(state.game && state.game.active);

  if (petMenuNote) petMenuNote.hidden = !locked;
  if (typeof petMenu.querySelectorAll !== 'function') return;

  const items = petMenu.querySelectorAll('.pet-menu-item');
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (!item) continue;
    const action = typeof item.getAttribute === 'function' ? item.getAttribute('data-action') : '';
    item.disabled = locked && action !== 'pomodoro-stop';
  }
}

/** 从点击目标往上找「那是一张手牌吗」。不用 closest：mock 元素不一定有 */
function closestGameHand(node) {
  let el = node;
  for (let i = 0; el && i < 4; i += 1) {
    if (el === gameHands) break;
    if (typeof el.getAttribute === 'function' && el.getAttribute('data-hand')) return el;
    el = el.parentElement;
  }
  return null;
}

function bindGameEvents() {
  if (gameHands && typeof gameHands.addEventListener === 'function') {
    // 用事件委托：三个按钮一个监听，以后加「布」之外的第四种手势也不用改绑定
    gameHands.addEventListener('click', (event) => {
      const btn = closestGameHand(event && event.target);
      if (!btn) return;
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      playRound(btn.getAttribute('data-hand'));
    });
  }

  if (gameClose && typeof gameClose.addEventListener === 'function') {
    gameClose.addEventListener('click', (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      endGame(true);
    });
  }

  if (gameAgain && typeof gameAgain.addEventListener === 'function') {
    gameAgain.addEventListener('click', (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      nextGameRound();
    });
  }

  if (gameQuit && typeof gameQuit.addEventListener === 'function') {
    gameQuit.addEventListener('click', (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      endGame(true);
    });
  }
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
 * 右键桌宠：打开菜单（Phase 3.18）。
 * 「查余额」变成了菜单里的一项，逻辑抽到 refreshBalance()。
 *
 * ⚠️ 必须 preventDefault：Electron 在 macOS 上会弹系统右键菜单，盖在桌宠上很出戏。
 * ⚠️ 只拦右键：左键的拖拽 / 点击开关气泡逻辑在 onMouseDown 里，button!==0 时直接返回。
 */
function onPetContextMenu(event) {
  event.preventDefault();
  event.stopPropagation();

  if (state.menuOpen) {
    closePetMenu();
    return;
  }

  // 右键时如果气泡开着，先记下指针位置：菜单定位用事件坐标，不用 state.pointer
  openPetMenu(event.clientX, event.clientY);
}

/**
 * 查余额（原 onPetContextMenu 的主体，Phase 3.18 抽出来给菜单用）。
 * 用 seq 拦住「连点两次右键 / 中途左键切回聊天」的旧结果覆盖新状态。
 */
async function refreshBalance() {
  const seq = ++state.balanceSeq;
  showWalletMessage(BALANCE_LOADING_TEXT);

  const result = await fetchBalance();
  // 期间用户可能左键切回聊天、或又点了一次查余额：旧请求不许盖掉新状态
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

  // Phase 3.16：能打字发消息，显然不是「闲着」，顺手把她叫醒
  markActive();
  wakeUp();

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
    // Phase 3.21：开启语音时念一遍（念的是剥掉 Markdown 的纯文本，
    // 而且只念开头 —— 详见 stripMarkdownForSpeech / clipForSpeech）
    speakText(result.text);
    // Phase 3.16：一轮对话结束 = 一次完整的「互动」，
    // 重新评估表情并刷新活跃时间（她刚说完话，不该马上又睡着）。
    markActive();
    updateBaseState();
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

  // 标题栏的「聊天 / 待办」页签：同一个气泡内切换，不关窗、不重开。
  if (bubbleTabChat) {
    bubbleTabChat.addEventListener('click', (event) => {
      event.preventDefault();
      setPanel('chat');
    });
  }
  if (bubbleTabTodo) {
    bubbleTabTodo.addEventListener('click', (event) => {
      event.preventDefault();
      openTodoPanel();
    });
  }

  // Phase 3.27：天气页签，和待办页签同一套「同一个气泡内切换」。
  if (bubbleTabWeather) {
    bubbleTabWeather.addEventListener('click', (event) => {
      event.preventDefault();
      openWeatherPanel();
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

  // Phase 3.21：语音 / 剪贴板吐槽也是「即时生效 + 即时落盘」，理由同上。
  if (speechSelect) {
    speechSelect.addEventListener('change', () => {
      applySpeechSetting(speechSelect.value === 'on', { persist: true });
    });
  }

  if (clipSelect) {
    clipSelect.addEventListener('change', () => {
      applyClipRoastSetting(clipSelect.value === 'on', { persist: true });
    });
  }

  // Phase 3.22：牌桌的三个出拳按钮 + 局末的两个选项（事件委托，见 bindGameEvents）
  bindGameEvents();

  // Phase 3.27：天气页的刷新 / 关闭按钮
  bindWeatherEvents();

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