# ERROR_LOG.md — 错误与排错记录

> 只记录有学习价值的错误，按五个问题来写：
> What happened? / What did we first think was wrong? / What was the real cause? /
> How was it fixed? / What did I learn?

---

## #1 · AI 无法启动 Electron 窗口做自测

- **When**：2026-10-19，Phase 1 代码写完后。
- **What happened**：
  AI 写完 5 个源文件后想运行 `npm start` 验证，终端返回 `command not found: node`，
  也就是这台机器上还没有安装 Node.js 运行环境。
- **What did we first think was wrong?**：
  一开始怀疑是项目配置写错了（`main` 字段指向不对 / 依赖没装），
  所以先去检查 `package.json` 和目录结构，但两个都是正确的。
- **What was the real cause?**：
  不是代码问题，而是环境问题 —— 开发机根本没有 Node.js / npm，
  自然也就装不上 Electron。AI 在"没有运行时"的环境里只能做静态检查，
  不能做真实的窗口行为验证。
- **How was it fixed**：
  把这一步明确划成 **Human-only Gate**：由你本人安装 Node.js，
  再执行 `npm install` 与 `npm start`，然后按 `PLAN.md` 的 A1–A10 亲手验收。
  AI 这边则退回到它能做的部分：检查 IPC 通道名在三个文件中是否一致、
  JSON 是否合法、`--pet-size` 与 `PET_SIZE` 是否同步。
- **What did I learn?**：
  1. **"AI 说完成"不等于"阶段完成"** —— 这次很典型：代码写完了，但真正的
     验收动作（打开窗口、点桌面、拖一拖）AI 根本做不到。
  2. 环境准备必须放在 BUILD 之前。课程流程里的 **TOOL** 阶段不只是"找工具"，
     也包含"确认工具在这台机器上真的能跑"。
  3. 这也说明为什么每个 Phase 都要有一个 Human-only Gate：
     AI 能验证"它是对的"（逻辑/语法），只有人能验证"它是有用的"（体验/意图）。

---

## #2 · 在浏览器里打开 index.html，看到白底和浏览器边框，以为 CSS 写错了

- **When**：2026-10-19，Phase 1 期间手动测试时。
- **What happened**：
  直接双击 / 拖拽 `src/index.html` 用浏览器打开，球能显示、也能拖拽，
  但整个页面是**白色背景**，外面还带着浏览器的窗口边框。
  第一反应是「`transparent` 没生效，是不是 CSS 写错了」，于是想靠
  `background: transparent !important` 把它改掉。
- **What did we first think was wrong?**：
  以为是 `style.css` 里 `html, body` 的背景色没设成透明。
- **What was the real cause?**：
  那层白底和边框**根本不是网页画的，是浏览器自己画的**。
  浏览器是个普通应用窗口，它的客户区默认就是白色，浏览器 UI 边框也不受网页控制。
  换句话说，`background: transparent` 改的是「网页内容的背景」，
  而白底是「浏览器窗口的背景」，两者不是一个东西，加多少 `!important` 都没用。
  真正的透明需要**窗口本身支持透明合成**——只有 Electron 开了
  `transparent: true` 的无边框窗口才能做到。
  顺带一提：在浏览器里还能拖拽，是因为 `renderer.js` 里对
  `window.petAPI` 不存在的情况做了降级保护（拖拽不依赖 Electron），
  而鼠标穿透完全依赖 IPC，所以在浏览器里必然是失效的。
- **How was it fixed**：
  1. 明确区分「浏览器调试」和「Electron 运行」：要验证透明/穿透必须用 `npm start`。
  2. 仍然按规范把 `html, body` 写成 `background: transparent !important`（无害且更稳），
     并在 CSS 里写明注释，避免下次再误会。
  3. 遇到白屏/无样式时，改用 `npm run dev` 打开 DevTools 看 Console，而不是靠猜。
- **What did I learn?**：
  1. **一个现象可以由完全不同的原因造成**。同一个「底色不透明」，
     在浏览器里是窗口背景，在 Electron 里才可能是 CSS 问题。
     排错第一步永远是先确认「我现在到底跑在哪个环境里」。
  2. 「改 CSS 就能变透明」是本次最大的误判。要先问：这块颜色是谁画的？
  3. 这也说明**降级保护要写清楚**：`renderer.js` 在浏览器里能拖拽，
     反而掩盖了「穿透没工作」这个事实 —— 幸好代码里打印了 `console.warn`。

---

## #3 · 凭记忆认为 main.js 在项目根目录，差点把 `"main"` 字段改成错的

- **When**：2026-10-19，Phase 1 配置核对时。
- **What happened**：
  以为项目结构是 `prompt-pet/main.js` + `prompt-pet/src/`，于是打算把
  `package.json` 的 `"main"` 从 `"src/main.js"` 改成 `"main.js"`。
- **What did we first think was wrong?**：
  觉得 `"main": "main.js"` 才是「标准写法」。
- **What was the real cause?**：
  磁盘上的真实结构是 **`prompt-pet/src/main.js`**，根目录根本没有 `main.js`。
  如果真按记忆改成 `"main": "main.js"`，Electron 会直接报
  `Unable to find Electron app` 启动失败。
  记忆和事实不一致时，**必须去看磁盘，而不是去改配置迁就记忆**。
- **How was it fixed**：
  1. 保持 `"main": "src/main.js"`（这是与真实结构匹配的正确取值）。
  2. 在 `main.js` 顶部写清楚完整的项目结构，并注明「改了会报什么错」。
  3. 增加启动前自检 `checkFiles()` 与 `did-fail-load` 监听，
     把「找不到文件」这类问题在终端里直接说清楚，而不是留下一个白屏。
- **What did I learn?**：
  1. `package.json` 的 `"main"` 是**相对项目根目录**的路径，
     必须指向真实存在的文件；文件挪了位置，这里就要跟着改。
  2. `win.loadFile('相对路径')` 的基准是**应用根目录**（`app.getAppPath()`，
     也就是 package.json 所在目录），**不是 main.js 所在目录** ——
     这是最容易踩的坑。改用 `path.join(__dirname, ...)` 拼绝对路径就完全免疫。
  3. 结论：**别凭记忆改配置，先 `ls` 看一眼**。

---

## #4 · Phase 2 的两个设计陷阱：单击/拖拽冲突、穿透窗口收不到外部点击

- **When**：2026-10-19 / Phase 2（交互弹窗）

- **What happened**：
  写气泡弹窗时连续撞上两个「看起来是 bug、其实是设计约束」的问题：

  1. **气泡根本点不开。** 因为 Phase 1 里「按下鼠标 = 开始拖拽」，于是每次点击
     球体都被当成一次拖拽，弹窗逻辑永远轮不到执行。
  2. **「点击气泡外部关闭」没法实现。** 想当然地去监听 `document` 上的 click，
     结果发现在穿透状态下，点在桌面上的那个点击**根本传不到窗口里来**。

- **What did we first think was wrong?**：
  1. 一开始怀疑是 `mouseup` 丢了、或者 `preventDefault()` 把默认行为搞坏了。
  2. 一开始怀疑是 `blur` 事件没绑上、或者 `pointer-events` 写错了。

- **What was the real cause?**：
  1. 不是 bug —— 是**两种手势共用同一个 `mousedown`**，必然冲突。
     鼠标只要动 1px 就会被判定成拖拽，而人手点击时几乎不可能做到 0 位移。
  2. 也不是 bug —— 是**穿透本身的语义**：`setIgnoreMouseEvents(true)` 就是
     「这个窗口不接收鼠标事件，转发给下层」。既然是转发，窗口自然收不到那次点击。

- **How was it fixed?**：
  1. **引入位移阈值 + 延迟判定。**
     `DRAG_THRESHOLD = 4px`，新增 `press` 状态机：按下时只记录起点，**先不决定**；
     等 `mousemove` 的位移超过阈值，才「升级」为拖拽（`press.moved = true`）；
     `mouseup` 时如果 `press.moved` 仍为 false，就判定为**单击**，才去切换气泡。
     这样手抖 1~3px 不会误判，用户的真实意图能被正确区分。
     同时特意保证：**拖拽过就一定不触发气泡**（`if (!wasDrag && onPet)`），
     避免「拖完手一松、气泡突然弹出来」这种最恼人的体验。
  2. **换一个可观测的信号。** 点桌面别处必然导致桌宠窗口**失去焦点**，
     所以监听 `window` 的 `blur` 来收起气泡。为此在打开气泡时先调
     `pet:focus-window` 让窗口拿到焦点（顺便让键盘输入直接进输入框），
     之后一旦失焦就说明用户点到了别处 → 收起。
     这一条同时解决了「点桌面关闭」和「ESC 之前得先让窗口有焦点」两个问题。

- **What did I learn?**：
  1. **同一个事件被两种手势共用时，不要立刻决定意图，而是「延迟判定」** ——
     用位移阈值这类可观测量去区分，是所有「点击 vs 拖拽」界面的通用解法。
  2. **穿透窗口是个「半聋」的窗口**：它能收到 hover 和按下，但收不到
     「发生在外部的点击」。要感知外部动作，只能依赖**焦点变化**这类间接信号。
  3. 有些「bug」其实是**架构约束的必然结果**，改代码没用，得换实现思路。

---

## #5 · 抠白底不能用「全局去白」，会把角色身上的白色一起打穿

- **When**：2026-10-22 / Phase 2 视觉替换（角色立绘）

- **What happened**：
  要把上传的 610×610 白底角色图抠成透明 PNG。
  第一反应是「扫描全图，把所有接近白色的像素 alpha 设为 0」。

- **What did we first think was wrong?**：
  以为只要把白色的阈值（容差）调准一点就行了。

- **What was the real cause?**：
  这个角色身上**本来就有大量白色**：女仆头饰的蕾丝花边、白色衣领、
  眼睛里的高光点。按颜色全局去白是不分青红皂白的 ——
  它会把这些「内容白」和「背景白」一起打穿，角色会变成一堆空洞。

- **How was it fixed?**：
  换成**从画布四个角做洪水填充**（flood fill）。区别在于：
  洪水填充判断的是「**连通性**」而不是「颜色」——
  它只吃掉与画布边缘连通的那一片白色。角色衣服上的白色被深色描边围着，
  和外部白底不连通，自然就完好地保留了下来。
  具体参数：容差 48（JPEG 白底并不纯白，不给容差会填不干净），
  标记色用亮品红（这个角色是蓝白色系，不可能撞色）。
  之后再对 alpha 做 1px 腐蚀 + 轻微羽化，去掉 JPEG 压缩在边缘留下的半透明白环。

- **What did I learn?**：
  1. 抠图要区分「背景色」和「内容色」，**同一个颜色既可能是背景也可能是内容**。
     能区分它们的是**位置和连通性**，不是颜色本身。
  2. 「从边缘向内扩散」是处理这类问题的通用套路（魔棒工具的默认行为也是这个）。
  3. 经验法则：**白底图 + 主体带白色 → 必须用洪水填充；只有背景纯净且主体无同色时才能用全局阈值。**

---

## #6 · 透明立绘的两个 CSS 陷阱：box-shadow 和原生拖拽

- **When**：2026-10-22 / Phase 2 视觉替换（角色立绘）

- **What happened**：
  把圆形球体换成透明背景的角色立绘后：
  1. 用 `box-shadow` 加投影，结果角色周围出现了一个**方形**的阴影框；
  2. 拖拽角色时，鼠标下冒出一张半透明的「幽灵图片」，自定义拖拽被搞乱。

- **What did we first think was wrong?**：
  1. 以为阴影颜色的透明度调低就能不明显。
  2. 以为是自己 mousemove 的坐标算错了。

- **What was the real cause?**：
  1. `box-shadow` 画的是**元素的盒子**（矩形）的阴影，
     它完全不知道图片里哪里是透明的 —— 元素是方的，影子就是方的。
  2. 是 Chromium 的**图片原生拖拽**（drag-and-drop API）在我们的
     `mousedown` 之外自己启动了，和自定义拖拽并行。

- **How was it fixed?**：
  1. 投影改用 `filter: drop-shadow(...)`。它是沿着元素的 **alpha 轮廓**渲染的，
     所以透明背景的立绘能得到贴合角色外形的影子。
     悬停高亮同理，用两层 `drop-shadow` 叠出品牌蓝光晕。
  2. 给 `<img>` 加 `draggable="false"`（并配合 body 上的 `-webkit-user-drag: none`），
     彻底关掉原生拖拽，只保留我们自己的逻辑。

- **What did I learn?**：
  1. **`box-shadow` 看盒子，`drop-shadow` 看轮廓。** 任何非矩形 / 透明背景的元素
     要投影，都应该优先考虑 `drop-shadow`。
  2. HTML 里 `<img>` 和 `<a>` 天生可拖拽，做自定义拖拽界面时**必须显式关掉**，
     否则会出现两套拖拽逻辑互相打架。

---

## #7 · 放大一个可拖拽元素时，不能只改视觉（「看得见摸不着」陷阱）

- **When**：2026-10-22 / UI 调整（角色放大一倍）

- **What happened**：
  要把桌宠放大一倍。最直觉的做法是给 `<img>` 加 `transform: scale(2)`，
  或者把 CSS 宽度改成 200%。但这样会出问题。

- **What did we first think was wrong?**：
  以为「放大」纯粹是个 CSS 视觉问题。

- **What was the real cause**：
  桌宠的**命中检测、拖拽、边界钳制、气泡定位**全部基于 `main.js` 里的
  `PET_SIZE` 常量（通过 IPC 传给渲染层）。
  如果只放大图片的视觉，而 `PET_SIZE` 还是 96，就会出现：
  角色看起来占了 192px，但**只有中间 96px 的方块能点中、能拖动**。
  更糟的是气泡定位也按 96 算，位置会明显偏离角色。
  用户会感觉「点不中它」——而且因为视觉上明明在一起，很难排查。

- **How was it fixed**：
  把尺寸常量整体翻倍，而不是只改视觉：
  `main.js` 的 `PET_SIZE 96 → 192`、`style.css` 的 `--pet-size: 96px → 192px`、
  `renderer.js` 的兜底 `size: 96 → 192`。**三处必须同步。**
  其余全部自动跟随（初始位置、钳制边界、气泡定位都是从 `PET_SIZE` 推导的）。

- **What did I learn?**：
  1. **可交互元素的「大小」是一个逻辑值，视觉只是它的表现。**
     任何缩放都必须改逻辑值，而不是去 hack CSS。
  2. 项目里凡是靠 IPC 传的常量（例子里的 `PET_SIZE`），
     改一处就要把「定义处 + 消费处 + 兜底值」全部找齐。
     只改定义处，兜底值会在 API 不可用时暴露成 bug（本项目的测试脚本
     正好走的就是「没有 petAPI」的兜底路径，所以立刻就能测出来）。
  3. 同一条原则也适用于描边宽度、命中容差（`hitPadding`）、
     图标尺寸 —— 它们都是「跟着尺寸走」的量。

---

## #8 · 尾巴换成伪元素后，`box-shadow` 就不好使了

- **When**：2026-10-22 / 气泡改聊天泡形状

- **What happened**：
  把气泡尾巴从「border 画的三角形」改成「一块独立的圆形伪元素」后，
  气泡的 `box-shadow` 立刻显得很假。

- **What was the real cause**：
  `box-shadow` 是给**元素的盒子**（矩形）投影的，它看不见伪元素。
  结果是气泡有一个方形影子，而尾巴完全没有影子 ——
  两个部件像是漂浮着拼在一起的，不像一个整体。

- **How was it fixed**：
  改用 `filter: drop-shadow(...)`。它按元素**渲染后的 alpha 轮廓**投影，
  会把气泡和尾巴当成一整个形状，影子自然连成一片。
  ⚠️ 同时必须**删掉原来的 `box-shadow`**，否则会多出一圈矩形影子。

- **What did I learn?**：
  `box-shadow` 只能描述矩形；只要元素外形不是矩形
  （圆角伪元素、透明 PNG、SVG、clip-path 裁剪过的图形），
  就应该改用 `drop-shadow`。这条和 #6 是同一个道理的两次踩坑。

---

## #9 · fetch 被 CSP 拦住，报错却长得像「网络不通」

- **When**：2026-10-22 / Phase 3 接 DeepSeek

- **What happened**：
  第一版代码写完，填入 key 发送，气泡里提示「网络好像不通」。
  但 `curl` 手打同一个接口是通的，浏览器里网络也是好的。

- **What did we first think was wrong?**：
  第一反应是 **CORS**：`file://` 页面的 `Origin` 是 `null`，
  DeepSeek 肯定会拒绝这种跨域请求，得改成主进程代理。

- **What was the real cause**：
  `index.html` 的 CSP 里**只写了 `default-src` 等几条，没有 `connect-src`**。
  按 CSP 规范，`connect-src` 会**回落到 `default-src`**，
  而 `default-src 'self' file:` 是不包含 `https://api.deepseek.com` 的 ——
  于是 `fetch` 在**发出去之前**就被策略拦了。
  CSP 拦截在控制台里表现为一个 failed 请求，不仔细看非常像 DNS / 网络故障。

- **How was it fixed**：
  在 `index.html` 的 CSP 里显式加一条 `connect-src 'self' file: https://api.deepseek.com;`。
  另外做了一次 **CORS 实测**来排除误判：curl 带 `Origin: null` 打真实接口，
  返回 `access-control-allow-origin: null`，并放行 `authorization, content-type` + `POST`
  —— 证明**预检本身是能过的**，问题只在 CSP。
  最后在启动自检里把「当前生效的 `connect-src`」打出来，以后改 CSP 一眼可见。

- **What did I learn?**：
  1. **`connect-src` 会回落到 `default-src`**，这是最容易漏的一条。
     只要项目里用 `fetch` / `XHR` / WebSocket，就必须显式写 `connect-src`。
  2. **「像网络故障」不等于网络故障**。同一个症状至少有三层可能：
     CSP 拦、CORS 拦、真网络问题。定位顺序应该是
     **先看控制台的报错属于哪一类**，再用 `curl` 验证服务端本身通不通，
     最后才去怀疑代码。
  3. mock 的测试**永远测不出这类问题** ——
     我的单元测试里 `fetch` 是假的，CSP 根本不存在。
     这也是后来补写 Electron 端到端自检的原因。

---

## #10 · 一进入「思考中」，角色就缩了一下

- **When**：2026-10-22 / Phase 3 思考动画

- **What happened**：
  加上 `.pet-sprite.thinking` 的摇摆动画后，一发送消息，
  角色会**先明显缩小、再开始晃**，晃动幅度反而比常态小。

- **What did we first think was wrong?**：
  以为动画的 `scale` 写错了，或者 `transform-origin` 被改动了。

- **What was the real cause**：
  `.pet-sprite` 的**常态**样式是 `transform: scale(1.1)`
  （用来补偿立绘四周约 10% 的透明留白）。
  而 CSS 动画运行时，**keyframes 里的 `transform` 会整体覆盖元素原有的 `transform`** ——
  不是叠加、也不是只改动的部分。
  我的 keyframes 只写了 `rotate(±2deg)`，等于每帧都把 `scale(1.1)` 抹掉了，
  角色就回到了 1.0 的尺寸，看起来就是「缩了一下」。

- **How was it fixed**：
  keyframes 的**每一帧**都写回完整变换，例如
  `transform: rotate(-2deg) scale(1.1);`，并把 `transform-origin` 冻结在 `50% 88%`
  不动（改它会让摇摆变成绕错点的甩动）。

- **What did I learn?**：
  **CSS 动画是用 keyframes 的整个 `transform` 替换元素的 `transform`，不是部分覆盖。**
  只要元素常态带 `scale` / `translate`（本项目的呼吸动画、拖拽层都带），
  写新动画时就必须把那些量**在每一帧抄回去**。
  这条和 Phase 1 的 D3（拖拽层与动画层拆成两级 DOM）是同一个坑的两个面：
  `transform` 只有一个，谁写谁覆盖。

---

## #11 · `hidden` 属性失效，聊天页和设置页同时显示

- **When**：2026-10-22 / Phase 3 双视图切换

- **What happened**：
  切到设置页时，聊天页**没有消失**，两个视图叠在一起，
  消息列表和 key 输入框同时出现在气泡里。

- **What did we first think was wrong?**：
  以为 JS 没设置 `hidden`，加了 `console.log` 确认 `element.hidden === true` ——
  属性确实设上了，界面却没变。这说明**问题在 CSS，不在 JS**。

- **What was the real cause**：
  `[hidden]` 只是浏览器默认样式表里的 `display: none`，**优先级极低**。
  我给 `.bubble-view` 写了 `display: flex`（作者样式），
  它直接**压过**了浏览器默认的 `[hidden] { display: none }` ——
  于是属性生效了、视觉效果却完全没变。

- **How was it fixed**：
  自己补一条高优先级的规则：`.bubble-view[hidden] { display: none; }`。
  顺带把「初始面板」也交给 JS 决定（init 里显式 `setPanel('chat')`），
  让 JS 成为视图状态的**唯一事实来源**，而不是依赖 HTML 上初始写死的 `hidden`。

- **What did I learn?**：
  `hidden` 属性不是「魔法开关」，它只是一个**可以被覆盖的默认样式**。
  凡是给元素设了 `display` 的组件，都要**自己把 `[hidden]` 的规则补回来**。
  另外：这类「属性对了但视觉没变」的现象，说明要**先去查 CSS 优先级**，
  而不是继续改 JS。

---

## #12 · 气泡内容换了之后「点不动」了

- **When**：2026-10-22 / Phase 3 消息列表 + 视图切换

- **What happened**：
  气泡刚打开时一切正常；一旦发送消息（气泡被内容撑高）、
  或从设置页切回聊天页，**气泡的某些区域就点不中了** ——
  尤其是底部，点下去直接把气泡当成「外部点击」收起了。

- **What did we first think was wrong?**：
  以为是消息列表的 CSS 有问题（比如某个子元素吃掉了事件）。

- **What was the real cause**：
  点击判定用的是**缓存下来的气泡尺寸** `state.bubbleSize`，
  它只在打开气泡那一刻测量一次。
  内容变多、视图切换、窗口尺寸变化之后，**缓存值就过期了** ——
  命中检测还在拿旧的高度做判断，底部那条新增的区域自然被判成「气泡之外」。

- **How was it fixed**：
  把「测量 + 重定位」打包成一个函数 `relayoutBubble()`
  （内部就是 `measureBubble()` + `positionBubble()`），
  在**所有会改变气泡内容或尺寸的地方**统一调用它：
  追加消息后、切换视图后、窗口尺寸变化后。

- **What did I learn?**：
  **缓存的布局数据必须有明确的失效时机。**
  只要一个量被缓存（尺寸、位置、偏移），就要在脑子里列一张
  「什么情况下它会变」的清单，并在每个变化点主动重算。
  这类 bug 的典型特征就是：「一开始是对的，动了之后就错了」。

---

## #13 · 测试里复制按钮第二次点不动（mock 定时器不自动跑）

- **When**：2026-10-22 / Phase 3 自测脚本

- **What happened**：
  自测脚本里第一次点「复制」通过，第二次点击时
  **什么都没发生**（没有写入剪贴板、按钮文案也没变）。

- **What did we first think was wrong?**：
  以为是复制逻辑真的写错了 —— 比如按钮上没有解绑旧的事件，
  或者两次点的是同一个被替换掉的 DOM 节点。

- **What was the real cause**：
  分成两半：
  1. **逻辑侧确实是「设计如此」**：复制成功后按钮会进入 `busy` 态并把文案改成
     「已复制」，1.4 秒后由 `setTimeout` 复位。防止连点重复触发。
  2. **真正的问题在测试环境**：我在 mock 里把 `setTimeout` 换成了「只登记、不执行」
     的版本，所以那个 1.4 秒的复位**永远不会发生** ——
     按钮卡在 `busy` 态，第二次点击被正确拦截了，测试却以为功能坏了。
  换句话说：**产品代码是对的，是测试没把时间推过去。**

- **How was it fixed**：
  给测试环境加了一个 `fireTimers()`：手动触发已登记的定时器回调，
  模拟「1.4 秒过去了」。在两次复制点击之间调用它，
  并**顺便新增一条断言**：复位后按钮文案必须回到「复制」。
  这样不仅修好了测试，还把「按钮必须能被再次点击」这条约束**变成了回归项**。

- **What did I learn?**：
  1. **mock 掉 `setTimeout` 就等于冻结了时间。**
     任何依赖「等一会儿发生」的逻辑（防连点、防抖、退场动画、超时），
     在 mock 环境里都必须显式推进定时器，否则测出来的是假故障。
  2. 遇到「第二次操作无效」，先分清是**幂等保护**还是**真的坏了**。
     前者是有意设计的边界，测试要去满足它，而不是绕开它。
  3. **一个 bug 修完，最好顺手把它变成一条断言** ——
     否则下次重构时还会原样再踩一次。

---

## 模板（复制下面这段写新的错误）

```
## #N · 一句话标题
- When：日期 / 阶段
- What happened：
- What did we first think was wrong?：
- What was the real cause?：
- How was it fixed?：
- What did I learn?：
```
