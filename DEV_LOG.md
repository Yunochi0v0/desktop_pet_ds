# DEV_LOG.md — 开发日志

> 每个阶段做了什么：完成事项 / 遇到的问题 / 下一步。
> 对应 Vibe Coding 流程的 **RECORD & ITERATE** 阶段。

---

## 2026-10-19 · Phase 1（Electron 基础框架与桌面透明悬浮）

### 完成事项
- [AI-GEN] 初始化项目结构：`package.json`、`.gitignore`、`src/` 目录。
- [AI-GEN] `src/main.js`：创建透明、无边框、始终置顶、隐藏任务栏图标的
  `BrowserWindow`，窗口尺寸铺满工作区；默认开启鼠标穿透并转发鼠标事件。
- [AI-GEN] `src/preload.js`：用 `contextBridge` 暴露 3 个白名单 IPC 方法。
- [AI-GEN] `src/index.html` + `src/style.css`：赛博发光圆球 + `translateY` 呼吸动画。
- [AI-GEN] `src/renderer.js`：命中检测驱动的动态鼠标穿透 + 按住拖拽 + 边界限制。
- [AI-GEN] 项目管理文件：`PROJECT_SCOPE.md`、`PLAN.md`、`DEV_LOG.md`、
  `DECISIONS.md`、`ERROR_LOG.md`、`buildLog.json`。

### 遇到的问题
| 问题 | 状态 |
| --- | --- |
| 本机没有 Node.js / npm，AI 无法真正启动 Electron 窗口做自测 | ⏳ 待人工完成（见 `ERROR_LOG.md` #1） |
| 拖拽用 `transform`、呼吸动画也用 `transform`，同一个元素上会互相覆盖 | ✅ 已解决：拆成 `#pet`（拖拽层）+ `.pet-core`（动画层）两级 DOM |
| 透明窗口在 macOS 上因 `transparent + resizable` 出现渲染错乱 | ✅ 已解决：`resizable: false`、`hasShadow: false`、`backgroundColor: '#00000000'` |

### 修正记录（同日追加，Electron 配置核对）

背景：在浏览器里直接打开 `src/index.html` 后，出现「白底 + 浏览器边框」，
并且发现对项目结构的记忆与磁盘不一致。于是做了一轮专项核对与加固。

**核对结果**
| 检查项 | 结果 |
| --- | --- |
| `transparent / frame / alwaysOnTop / skipTaskbar` 四项配置 | ✅ 已全部存在 |
| `setIgnoreMouseEvents(true, { forward: true })` | ✅ 已存在 |
| 接收 IPC 动态取消穿透 | ✅ 已存在 |
| 加载路径 | ✅ 用 `path.join(__dirname, 'index.html')`，比 `loadFile('src/index.html')` 更稳 |
| `package.json` 的 `"main"` | ✅ 为 `"src/main.js"`（对应真实结构；写成 `"main.js"` 会启动失败） |
| `html, body` 背景 | ✅ 已改为 `background: transparent !important` |
| `preload.js` | ⚠️ 用户记忆里没有它，但它**必须存在**，否则穿透失效 |

**本轮代码改动 [AI-GEN]**
- `style.css`：`html/body` 背景改为 `background: transparent !important`，
  并加注释说明「浏览器里的白底是浏览器窗口画的，CSS 改不掉」。
- `main.js`：
  - 新增 `INDEX_HTML` / `PRELOAD_JS` 绝对路径常量，并把 `loadFile` 的路径基准坑写进注释；
  - 新增启动前自检 `checkFiles()`，找不到文件时在终端直接报错；
  - 新增 `did-fail-load` 监听，页面加载失败时打印错误码与原因；
  - `console-message` 监听改为兼容 Electron 35+ 的新签名，避免新版静默失效。
- `index.html`：CSP 显式放行 `file:` 协议，避免 `file://` 页面上 `'self'`
  匹配不到本地资源而导致无样式 / 脚本不执行。

**本轮验证 [AI-GEN 自测]**
用 JavaScriptCore 真实执行 `renderer.js`（mock DOM + 模拟鼠标事件），13 项断言全部通过：
初始位置、悬停进入可交互、移开恢复穿透、命中容差、拖拽跟随、
左上/右下边界钳制、拖拽中保持可交互、松手后不再跟随。详见
`outputs/electron-run-guide.md`。

**仍然待你本人完成 [MANUAL]**
安装 Node.js → `npm install` → `npm start`，然后按 A1–A10 验收。
AI 依旧无法启动真实窗口（本机无 Node.js）。

### 下一步
1. **你本人**安装 Node.js → `npm install` → `npm start`。
2. 按 `PLAN.md` 的 A1–A10 逐条亲手验收，把结论补写在本文件下方。
3. 验收通过后 commit（信息见 `buildLog.json`），再开始 Phase 2。

### Phase 1 人工验收记录（✅ 已确认通过）
```
日期：2026-10-19
环境：由本人自行测试（未提供 macOS / Node / Electron 版本号）

验收结论：✅ 通过 —— 本人在对话中确认「桌宠经过测试，无问题」，允许进入 Phase 2。

说明：本次为整体结论，未逐条勾选 A1–A10。如需完整可追溯的逐条留档，
      请补填下面的空白模板后替换掉本段。
```

### 空白模板（如需逐条留档时填写）
```
日期：
环境：macOS ____ / Windows ____     Node 版本：v____     Electron 版本：____

A1 发光圆球出现在右下角        □ 通过  □ 不通过  备注：
A2 无边框 / 无标题栏          □ 通过  □ 不通过  备注：
A3 任务栏 / Dock 无图标        □ 通过  □ 不通过  备注：
A4 点击透明区域穿透到桌面      □ 通过  □ 不通过  备注：
A5 鼠标悬停球体高亮            □ 通过  □ 不通过  备注：
A6 按住可拖动                  □ 通过  □ 不通过  备注：
A7 无法拖出屏幕可视区域        □ 通过  □ 不通过  备注：
A8 呼吸动画流畅无闪白          □ 通过  □ 不通过  备注：
A9 其他窗口全屏后仍在最上层    □ 通过  □ 不通过  备注：
A10 DevTools Console 无报错    □ 通过  □ 不通过  备注：

验收结论（可进入 Phase 2 / 需要修复）：
```

---

## 2026-10-19 · Phase 2（交互弹窗 / 气泡对话框）

### 完成事项
1. **`src/index.html`**：新增气泡 DOM —— `#bubble`（定位层）> `.bubble-inner`（动画层）>
   标题条（发光小圆点 + "Prompt Pet"）→ `#bubble-input`（textarea）→ 底部状态与
   `#bubble-send` 按钮（`disabled`，title 写明「Phase 3 接入 AI API 后启用」）。
   渲染层刻意拆成「定位层 / 动画层」两层：外层只负责 `translate3d` 跟着球走，
   内层只负责 `scale + opacity` 的淡入动画 —— 放同一层上两个 transform 会互相覆盖。
2. **`src/style.css`**：新增 `--bubble-w: 264px`；气泡完整样式（毛玻璃深色面板、四角
   与球同色系描边、小箭头、输入框与按钮的 hover/focus 态）；`body.bubble-open` 时
   气泡 `opacity: 1 + visibility: visible`；`@media (prefers-reduced-motion)` 里
   一并关掉气泡的过渡动画。
   - 关键：气泡用 `visibility: hidden` 而不是 `display: none`，因为**隐藏时仍保留布局尺寸**，
     JS 才能在显示前就测到 `offsetWidth/offsetHeight`，否则第一次打开会「先在错位置出现再跳一下」。
   - 关键：`.bubble-input` 显式写了 `user-select: text` —— body 上有 `user-select: none`，
     不覆盖的话输入框里没法用鼠标选中文字。
3. **`src/renderer.js`**：Phase 2 的全部交互逻辑（详见下方「两个设计难题」）：
   - 新增 `DRAG_THRESHOLD = 4`、`BUBBLE_GAP = 14`、`press` 状态机；
   - 命中检测扩展为 `isPointInteractive() = 球体 ∪ 打开中的气泡`；
   - `measureBubble()` / `positionBubble()`：默认球左上方 + 右对齐 + 上方放不下翻到下方 +
     最后钳制进屏幕，并切换 `data-arrow` 控制箭头朝向；
   - `openBubble()` / `closeBubble()` / `toggleBubble()`；
   - 三种关闭方式：再次单击球体、ESC、窗口失焦。
   - 拖动球体时会调用 `positionBubble()`，气泡像「长在球上」一样跟随。
4. **`src/preload.js`**：新增第 4 个白名单方法 `focusWindow()`，顶部注释同步更新为 4 个。
5. **`src/main.js`**：新增 `ipcMain.on('pet:focus-window')`，带 `isTrustedSender()` 校验。
6. **文档**：`PLAN.md` 的 Phase 2 从草稿升级为正式验收标准（B1–B10）；
   本文件的 Phase 1 验收结论已填写；`ERROR_LOG.md` 新增 #4；`buildLog.json` 新增 Phase 2 记录。

### 两个必须记下来的设计难题
> 这两个坑是 Phase 2 真正的核心，代码里也都写了注释，详见 `ERROR_LOG.md` #4。

**① 单击和拖拽会互相冲突。**
如果按下鼠标就当拖拽，那用户永远点不开气泡；如果按下就当单击，那用户就没法拖球。
最终方案：按下时**先不决定**，等鼠标位移超过 `DRAG_THRESHOLD`（4px）才「升级」为拖拽；
松开时若从未升级过，才判定为一次单击。这样手抖 1~3px 不会误判成拖拽。

**② 穿透窗口根本收不到「点在桌面上」的那个点击。**
因为窗口默认穿透，事件被转发给桌面了，所以「点击气泡外部关闭」没法用普通的
「监听 document 的 click」来实现。最终方案：换个思路 —— 用户点桌面别处必然导致
桌宠窗口**失去焦点**，那就监听 `window` 的 `blur` 来收起气泡。效果一样，而且更省事。

### AI 自测结果
- 3 个 JS 文件语法解析全 OK；`package.json` / `buildLog.json` JSON 校验通过。
- IPC 通道名 `main.js` 与 `preload.js` 两处**完全一致**（4 条：set-ignore-mouse-events /
  get-bounds / get-pet-size / focus-window）。
- HTML 元素 id ↔ `renderer.js` 引用一一对应（`pet` / `bubble` / `bubble-input`）。
- CSS 类名 `interactive` / `bubble-open` / `dragging` 在 CSS 与 JS 两处都存在。
- 尺寸常量同步：`--pet-size 96` ↔ `PET_SIZE 96`；`--bubble-w 264` ↔ `BUBBLE_FALLBACK.w 264`。
- **JavaScriptCore 真实执行 `renderer.js`（mock DOM + 模拟鼠标事件）：40 项断言全部通过。**
  含 Phase 1 回归 11 项（初始位置 / 悬停穿透切换 / 命中容差 / 拖拽跟随 / 四向边界 /
  松手后不再跟随）+ Phase 2 新增 29 项（单击开合 / 气泡定位与边界 / 穿透联动 /
  ESC 与失焦关闭 / **拖拽不误触气泡** / 边界处气泡翻转与钳制 / 拖动时气泡跟随）。

### 仍然待你本人完成 [MANUAL]
`npm start`，按 `PLAN.md` 的 **B1–B10** 逐条亲手验收。
重点是三条最容易出问题的：
- **B2 / B3**：把球拖到屏幕四个角 + 最顶部，逐个位置点开气泡看位置对不对、有没有被裁掉；
- **B8**：连续快速拖动球 5 次以上，确认气泡**一次都没被误触发**；
- **B10**：关掉气泡后重新验证 Phase 1 的 A4（穿透）和 A7（边界）没被破坏。

AI 依旧无法启动真实窗口（本机无 Node.js / npm），气泡的观感、输入体验、失焦时机
都只能由你本人确认。

### 下一步
1. **你本人** `npm start`，按 B1–B10 逐条验收，把结论补写在本文件下方。
2. 验收通过后 commit（信息见 `buildLog.json` 的 `phase2-002`），再开始 Phase 3（AI API 接入）。
3. Phase 3 才动 `#bubble-send` 按钮（目前刻意留成 `disabled`，避免误以为已经能用）。

### Phase 2 人工验收记录（待你填写）
```
日期：
环境：macOS ____ / Windows ____     Node 版本：v____     Electron 版本：____

B1  单击角色弹出气泡，角色位置不变      □ 通过  □ 不通过  备注：
B2  气泡在角色左上方且不被屏幕边缘裁掉  □ 通过  □ 不通过  备注：
B3  角色贴近屏幕顶部时气泡翻到下方      □ 通过  □ 不通过  备注：
B4  打开后可直接打字，无需先点输入框    □ 通过  □ 不通过  备注：
B5  输入框内可正常选中/删除/换行        □ 通过  □ 不通过  备注：
B6  再次单击角色收起气泡                □ 通过  □ 不通过  备注：
B7  点击气泡以外区域气泡自动收起        □ 通过  □ 不通过  备注：
B8  拖动角色不会误弹出气泡              □ 通过  □ 不通过  备注：
B9  拖动角色时气泡跟随移动              □ 通过  □ 不通过  备注：
B10 气泡收起后穿透/边界仍正常（回归）   □ 通过  □ 不通过  备注：
B11 角色立绘完整，周围透出桌面无空洞    □ 通过  □ 不通过  备注：
B12 悬停角色有品牌蓝高亮，移开消失      □ 通过  □ 不通过  备注：
B13 气泡为 DeepSeek 浅色风格，尾巴指向角色 □ 通过 □ 不通过 备注：
B14 呼吸幅度轻微，不会一直分散注意力    □ 通过  □ 不通过  备注：
B15 弹出气泡有「聊天泡冒出来」的弹出手感 □ 通过 □ 不通过  备注：

验收结论（可进入 Phase 3 / 需要修复）：
```

---

## 2026-10-22 · Phase 2 视觉替换（角色立绘 + DeepSeek 风格气泡）

> 阶段说明：这不改变 Phase 2 的功能范围，只替换视觉呈现。
> 交互逻辑（renderer.js）**一行都没改**，40 项回归断言重跑后依然全部通过。

### 需求
1. 用上传的角色立绘，替换原来的「赛博发光圆球」。
2. 把气泡对话框改成 DeepSeek 风格。

### 一、角色立绘（抠图 + 替换）

**素材处理**：原图是 610×610 的 JPEG，纯白背景。产出
`src/assets/pet-character.png`（256×256 透明 PNG，58.4 KB）。

抠图用的是**从四个角做洪水填充**，而不是「把全图所有接近白色的像素都变透明」。
这个选择很关键 —— 因为这个角色身上有大量白色（女仆头饰的蕾丝、衣领、眼睛高光），
如果按颜色全局去白，这些地方会被一起打穿，角色会变成一堆空洞。
而洪水填充只吃掉**与画布边缘连通**的那片白色，被深色描边围住的内部白色自然就保住了。

处理链：
1. 四角洪水填充（容差 48，JPEG 白底并不纯白，不给容差会填不干净）；
2. 标记色 → 全透明（用亮品红当标记色，因为这个角色是蓝白色系，不可能撞色）；
3. alpha 先**腐蚀 1px** 再轻微羽化 —— 去掉 JPEG 压缩在边缘留下的半透明白环；
4. 按 alpha 自动裁剪（566×601）+ 留 3% 白边，等比缩放居中放进 256×256 画布。

**替换的地方**：
- `index.html`：`.pet-core` 里原来的 `.pet-ring` / `.pet-eye` 两个装饰 div 删掉，
  换成 `<img class="pet-sprite" src="assets/pet-character.png" draggable="false">`。
- `style.css`：`.pet-core` 去掉圆形渐变背景 / 黄色发光边框 / box-shadow，
  变成纯粹的动画容器；新增 `.pet-sprite` 样式。

**两个必须注意的 CSS 细节**：
1. **投影必须用 `drop-shadow` 而不是 `box-shadow`。** `box-shadow` 会画出一个
   方形影子，透明背景的立绘立刻就会「露馅」（角色周围出现一个方框）。
   `drop-shadow` 是沿着立绘的 alpha 轮廓走的，才正确。
2. **`draggable="false"` 不能省。** 否则拖拽时 Chromium 会启动图片的原生拖拽，
   冒出一张半透明的「幽灵图片」，和我们的自定义拖拽打架。

另外：`.pet-sprite` 加了 `transform: scale(1.1)`，因为立绘四周有约 10% 的透明留白，
放大一点让角色更饱满地填满 96px 的命中框。

### 二、DeepSeek 风格气泡

配色取自 DeepSeek 品牌蓝 `#4d6bfe`，整体走「浅色卡片 + 克制阴影」：

| 部位 | 改动 |
| --- | --- |
| 卡片底 | 深色毛玻璃 → 纯白 `#ffffff`，圆角 14px → 16px |
| 边框 | 黄色发光描边 → 极浅灰 `#e6e9f2` |
| 阴影 | 外发光 → 柔和的 `0 10px 30px rgba(23,33,72,.16)` |
| 标题 | 琥珀色 → DeepSeek 蓝，加了 `font-weight: 600` |
| 输入框 | 深色凹槽 → 浅灰 `#f5f7fb`**无边框**，聚焦时才亮起品牌蓝描边 + 3px 光晕 |
| 发送按钮 | 黄色描边胶囊 → 品牌蓝实心胶囊 + 白字 |
| 箭头 | 黄色 → 白色（必须跟卡片底色一致，否则会看到突兀色块） |
| 文案 | 标题改为 `DeepSeek`，placeholder 改为「给 DeepSeek 发送消息」 |

标题条的小圆点保留，颜色换成品牌蓝并加了微光晕。

### 三、新增预览页（不需要 Electron 就能看效果）

`outputs/phase2-preview.html`（249 KB，完全自包含：内联 style.css + base64 角色图）。
用三个「舞台」模拟桌面，分别展示：① 待机状态、② 气泡在角色左上方、
③ 角色贴顶时气泡自动翻到下方。样式直接取真实的 `style.css`，
所以在浏览器里看到的就是 Electron 里会呈现的样子（只少了透明合成）。

### AI 自测结果
- 角色立绘：`RGBA / 256×256 / 58.4 KB`；**四角与最外圈 alpha 全部为 0**（独立用 PIL 逐像素复核）；
  中心像素 `(107,129,187,255)` 证明角色本体没被误删；边缘半透明像素仅 1.47%（正常羽化）。
- 旧球体元素清理干净：`pet-ring` / `pet-eye` / `--neon` 在 HTML 与 CSS 中均已无残留。
- CSS 括号平衡（35/35），关键选择器齐全。
- 尺寸常量仍同步：`--pet-size 96` ↔ `PET_SIZE 96`；`--bubble-w 264` ↔ `BUBBLE_FALLBACK.w 264`。
- CSP 的 `img-src 'self' data: file:` 允许加载本地立绘；`draggable="false"` 已加。
- **重跑 renderer.js 的 40 项断言：仍然 40 通过 / 0 失败**（证明本次纯视觉改动没有影响交互逻辑）。

⚠️ 注意：`deepworks_image_inspect` 工具对这张图报了 `transparent_corners_missing`，
但用 PIL 逐像素复核后确认**四角 alpha 确实为 0（完全透明）**，是工具误报。

### 下一步
- 立绘的**观感**（清晰度、大小是否合适、悬停高亮是否明显）仍需你本人确认。
- Phase 2 的 **B1–B10 仍未验收**，另外新增视觉效果项 **B11–B13**（见 `PLAN.md`）。

---

## 2026-10-22 · UI 调整（第二轮）：放大角色 / 收敛呼吸 / 气泡变聊天泡

### 需求
1. 角色图像放大一倍；
2. 减小呼吸动画的上下移动幅度；
3. 弹出气泡时要有「聊天泡冒出来」的效果；
4. 气泡改成聊天泡的形状；
5. 文本框内显示的文字改为「为什么不问问大肥鱼？」。

### 一、放大一倍：改 `PET_SIZE`，而不是只放大图片

**关键判断**：`renderer.js` 的命中检测、拖拽、边界钳制、气泡定位**全部基于
`PET_SIZE`**。如果只把图片视觉放大（比如给 `<img>` 加 `scale(2)`），
就会出现「角色看着很大、但只能点到中间一小块」的错位 —— 看得见摸不着。

所以正确做法是把尺寸常量整体翻倍：
`main.js` 的 `PET_SIZE 96 → 192`、`style.css` 的 `--pet-size 96px → 192px`、
`renderer.js` 的兜底 `size: 96 → 192`。三处必须同步，否则会出现
「可见大小」和「可点区域」不一致。

其余全部自动跟随：初始位置、四个方向的钳制边界、气泡定位都是从 `PET_SIZE`
算出来的，改一个常量就够。

**清晰度**：素材是 256×256，现在显示 192px（再乘 1.1 的立绘补偿 ≈ 211px），
仍是**缩小**渲染，所以 Retina 下依然锐利，不需要重新导出素材。

### 二、呼吸幅度：-9px → -3px

`@keyframes idle-breathe` 的位移从 9px 压到 3px，缩放从 1.02 收到 1.008。

理由：桌宠是**常驻桌面**的东西，一直待在屏幕角落的眼角余光里。
幅度一大就会变成持续晃动，几分钟就让人烦躁。
现在的幅度只够表达「它是活的」，不会抢注意力。

### 三、气泡「冒出来」的效果

原来是 `translateY(6px) scale(0.97)` 的平淡淡入，现在改成：

```css
transform: translateY(10px) scale(0.2);
transition: transform 0.34s cubic-bezier(0.34, 1.56, 0.64, 1);
```

三个要点：
1. **从很小的 scale(0.2) 开始弹** —— 像气泡从一点鼓起来；
2. **贝塞尔曲线的控制点 1.56 会产生「过冲」**（先超过 1 再回弹到 1），
   这就是「啵」的手感来源，没有过冲就只是普通的放大；
3. **`transform-origin` 跟着尾巴方向走**：气泡在角色上方时原点在底部
   （`50% 100%`），在下方时翻到顶部（`50% 0%`），这样它总是**从角色那一侧**长出来。

### 四、气泡形状：从「对话框」改成「聊天泡」

| 部位 | 改动 |
| --- | --- |
| 圆角 | 16px → **22px**（圆润感主要来自这里） |
| 尾巴 | 尖三角形 → **半个圆**（26px 圆形 + `clip-path` 裁掉一半） |
| 尾巴位置 | 居中 → **靠右 80px**（角色在气泡右下方，尾巴要朝那边指） |
| 投影 | `box-shadow` → **`filter: drop-shadow`** |
| 输入框圆角 | 10px → 14px |

**为什么投影必须跟着换**：尾巴现在是一块独立的伪元素。
`box-shadow` 只认元素自己的矩形盒子，会给气泡画一个**方影子**，
而尾巴是「贴上去的」，两者阴影对不上，一眼就看出是两个部件。
`drop-shadow` 是把「气泡 + 尾巴」当成一整个 alpha 轮廓来投影，
边缘才连得上，看起来才是一个完整的泡泡。
（换的时候要记得**删掉 box-shadow**，否则会多出一圈矩形影子。）

### 五、文本框提示文字

`placeholder` 改为「为什么不问问大肥鱼？」。
注意这里改的是 **placeholder**（灰色提示文字），不是预填内容 ——
输入框仍是空的，发送按钮仍然禁用。

### AI 自测结果
- **测试脚本重写：把尺寸参数化**（`SIZE` 一个常量 + 由它推导的初始位置/钳制边界/
  气泡位置），以后改大小不用再手工重推几十个坐标。
- **43 项断言全部通过 / 0 失败**（比之前多 3 项：新增了「气泡翻回 down」
  「翻转后仍完整落在屏幕内」等边界验证）。
- 全部改动点用脚本逐条核对：`--pet-size 192px`、`PET_SIZE 192`、兜底 192、
  呼吸 -3px、过冲贝塞尔、`transform-origin` 双向、圆角 22px、半圆尾巴、
  尾巴靠右、placeholder 文案 —— **10 项全部 ✅**。
- CSS 括号平衡（36/36）；旧的三角形尾巴规则已彻底移除；`box-shadow` 已换 `drop-shadow`。
- 预览页 `outputs/phase2-preview.html` 已按新尺寸（192px）和新气泡形状重新生成。

### 下一步
- **Phase 2 人工验收 B1–B13 仍未做**，本轮又新增 **B14（呼吸幅度）**
  和 **B15（冒出动画）**，见 `PLAN.md`。
- 「冒出来」的动画手感和放大后的整体观感**只能在真实 Electron 窗口里判断**，
  本机此前没有 Node，无法启动（已在 `outputs/electron-run-guide.md` 留了安装说明）。

---

## 2026-10-22 · 首次真实启动（Electron 环境验证）

### 环境
- Node **v24.22.0** / npm **11.19.1**（本机已具备）
- `npm install` → **up to date**（依赖此前已装好，无需重新下载）
  - ⚠️ npm 提示 `electron@33.4.11` 的 postinstall（`node install.js`）未被 allowScripts 覆盖，
    但**二进制实际已经存在**，无需处理。校验方式见下。
- Electron 二进制校验（**不要只看 `MacOS/Electron` 这个 49K 的启动垫片**）：
  - `node_modules/electron/dist` 体积 **242M** ✅
  - `Electron.app/Contents/Frameworks/Electron Framework.framework` 存在 ✅
  - `./node_modules/.bin/electron --version` → **v33.4.11** ✅（这条才是决定性验证）

### 启动过程
- 发现**已经有一个实例在跑**（PID 2560，启动于 17:35:51），
  但它早于本轮改动（17:41–17:46），**跑的是旧的 96px 版本**。
- `main.js:248` 有**单实例锁**，直接再跑一次只会让旧窗口 `show()`，
  **不会**加载新代码 → 必须先退出旧实例。
- 已 `SIGTERM` 旧实例 → 重新启动 → 进程存活，日志只有一行文件自检通过，**无任何报错**：
  ```
  [PromptPet] 文件自检通过：index.html / preload.js 均已找到。
  ```
- 日志里**没有**出现 `[PromptPet] 未检测到 petAPI` 警告 —— 这条警告在自测脚本
  （无 Electron 环境）里每次都会出现，现在没有，**说明 `preload.js` 的 API 注入正常**。

### 截图验证结果（用 `screencapture` 抓真实屏幕）
已验证 ✅：
- 角色立绘正常渲染，**大小明显变大**（192px，与 Dock 图标对比合理）；
- **透明生效** —— 角色后面的桌面 / DeepWorks 界面文字能直接透出来，没有白底方块；
- **立绘没有被裁切** —— 头饰、蕾丝、眼睛、领结、下摆轮廓完整，
  底部那条平边是**原画本来就是半身像**，不是裁剪；
- 角色停在**工作区右下角、Dock 上方**，四周留白充足。

### 发现的一个已知限制（非本轮引入）
- `renderer.js` **没有监听 `resize`**，位置只在启动时按 `pet:get-bounds` 算一次。
- `main.js` 用 `screen.workArea`（刻意避开菜单栏 / Dock，这是对的），
  但**如果启动后再切换 Dock 显示/隐藏**，窗口尺寸和角色位置都不会重算，
  角色可能压在 Dock 上或离边缘过远。
- 影响很小（重启即恢复），**建议留到 Phase 3 顺手修**：
  主进程监听 `screen.on('display-metrics-changed')` 后重新下发 bounds 即可。

### 环境小知识（写下来免得下次再踩）
- 真实屏幕 **1512×982**（Retina 3024×1964），窗口用的是 **workArea**（约 1512×905，随 Dock 变化），
  所以「窗口尺寸」≠「屏幕尺寸」，两套坐标不要混用。
- `osascript` 的 `click at {x,y}` 会报 **-25208**（终端没有「辅助功能」权限），
  因此**无法用脚本模拟点击**打开气泡 —— 交互类验收（冒出动画）只能由人来点。

### 下一步（**需要你亲手做**）
- 打开气泡：**单击右下角的角色**，然后照着 `outputs/phase2-guide.md` 的 **B1–B15** 逐条看。
- 想退出应用：角色没有 Dock 图标，先单击角色让窗口拿到焦点，再按 **⌘Q**；
  或者用「活动监视器」结束 `Electron`。

---

## 2026-10-22 · Phase 3：DeepSeek 接入（BYOK）+ 思考特效 + 结果渲染

### 目标与硬约束（先写在这，免得自己越界）
- 一个目标：把气泡里的文字发给 DeepSeek，把回答显示回气泡。
- 两条硬约束：
  1. 项目**只有一张立绘**，所以「思考中」**只能**靠 CSS 动画 / 光效 ——
     任何切换 `src` 的差分图写法，一律不写。
  2. 思考特效**不要**霓虹 / 扫描线 / 故障感：桌宠是浅色 DeepSeek 风格，
     赛博朋克会直接跟它打架。

### 一、密钥（BYOK：由使用者自己填）
- 存哪：`localStorage['deepseek_api_key']`；请求头 `Authorization: Bearer <key>`。
- 界面上**只显示掩码**（`sk-…后4位`），保存 / 清除都有明确文案。
- 日志里**永远不打印 key**，只打一个布尔：`已有 API key=否`。
- 设置页的「清除」按钮类名是 `.bubble-ghost` ——
  **特意不叫 `.bubble-link`**：那个类名是 Markdown 链接在用的，
  借来当按钮会把「蓝字 + 灰 URL」的链接样式污染到按钮上。

### 二、为什么让渲染进程直接 fetch，而不走主进程代理
一开始我也倾向「密钥只留主进程」（这是 `DECISIONS.md` D4 的原话），
实测之后改了主意 —— 用 curl 带 `Origin: null` 打真实接口：

| 探针 | 结果 |
| --- | --- |
| `access-control-allow-origin` | 回 `null`（不是 `*`，但 `file://` 页面的 Origin 恰好也是 `null`） |
| `access-control-allow-headers` | 放行 `authorization, content-type` |
| `access-control-allow-methods` | 放行 `POST` |
| 不带 key 直接 POST | `401 Authentication Fails` |

结论：**预检能过，渲染进程可以直接 fetch**，不需要主进程代理。
既然不代理，key 就只能待在渲染进程手上 ——
于是 D4 的「只留主进程」在这一阶段被推翻，改存 localStorage。
理由与取舍写进了 `DECISIONS.md` 的 D7 / D8。

### 三、CSP 是最坑的一环（详见 `ERROR_LOG.md` #9）
`index.html` 原来的 CSP 里**没有 `connect-src`**，
结果 `fetch` 被 CSP 直接拦掉，而报错长得**像网络不通**。
这种错最难查：代码没错、网络也没错，是策略在拦。
修法是显式写一条：

    connect-src 'self' file: https://api.deepseek.com;

并且启动时把「当前真正生效的 connect-src」打印出来，
以后再有人动 CSP，终端里立刻能看见。

### 四、思考特效（只用一张图）
- 角色：`.pet-sprite.thinking` 轻微摇摆 + `.pet-core::before` 光晕呼吸。
- 气泡：状态行改成「正在思考」，发送按钮禁用。
- 全局：`body.thinking` 调一点点氛围。
- ⚠️ 踩了个大坑：动画会**整体覆盖** `transform`，
  而 `.pet-sprite` 常态是 `scale(1.1)` —— keyframes 里必须每帧写回 `scale(1.1)`，
  否则一进入思考角色就「缩一下」（详见 `ERROR_LOG.md` #10）。
- `prefers-reduced-motion: reduce` 时不播思考动画（可访问性）。

### 五、结果渲染
- 安全顺序：**先整体 `escapeHtml`**，再做白名单式 Markdown 替换。
  反过来（先替换再转义）等于把用户输入当 HTML 用，必出 XSS。
- 支持：粗体、行内代码、代码块、标题、有序 / 无序列表、引用、链接。
- 链接渲染成「蓝色文字 + 灰色 URL」，**不生成可点击的 `<a>`** ——
  桌宠是常驻悬浮窗，误点链接弹出浏览器很烦。
- 用户输入、错误提示、系统提示一律用 `textContent`。

### 六、其他实现选择
| 决定 | 原因 |
| --- | --- |
| Enter 换行、⌘/Ctrl+Enter 发送 | 允许粘贴多行代码；`isComposing` 判断避免中文输入法打字中误发 |
| `state.sending` 期间拦截重复发送 + 禁用按钮 | 「请求不会重复发送」是课程明确要求 |
| 只保留最近 10 轮（20 条）历史 | 上下文有用但会无限涨 token，10 轮够用 |
| 气泡宽度 264px → **300px** | 回答里带代码时 264 太窄；同步改 `BUBBLE_FALLBACK.w` 与测试常量 |
| 复制三级兜底 | 主进程 `clipboard` → `navigator.clipboard` → `execCommand('copy')` |
| 错误文案分档 | 401/403 说饭卡、402 说余额、429 说歇一会儿、超时说等太久、断网说网络不通 |

### AI 自测结果
- **Node 回归测试 148 项全部通过 / 0 失败**（`.deepworks/tmp/test-renderer.mjs`；
  Phase 3.5 追加后已扩充到 190 项）。
  它用 `node:vm` 真实执行 `renderer.js`（mock DOM / localStorage / fetch /
  定时器 / `AbortController`），覆盖 Phase 1 + Phase 2 的全部回归项，
  外加 Phase 3 新增的密钥、请求、错误映射、超时、去重、Markdown、
  复制兜底、localStorage 不可用时的降级路径。
- **Electron 端到端自检通过**（`.deepworks/tmp/e2e-electron.js`）：
  require 真实的 `main.js`（窗口配置、IPC handler、preload 全是真的），
  窗口在 `ready-to-show` 后立刻 `hide()`，**整个过程不打扰桌面**。

  | 检查项 | 结果 |
  | --- | --- |
  | 新增节点（齿轮 / 双视图 / 消息列表 / key 输入 / 状态行） | 全部存在 ✅ |
  | 初始视图 | 聊天页可见、设置页隐藏、标题 `DeepSeek` ✅ |
  | 真正生效的 CSP | 已含 `connect-src 'self' file: https://api.deepseek.com` ✅ |
  | `file://` 下的 localStorage | 可用 ✅ |
  | preload 暴露的 API | 6 个（含 `copyText`）✅ |
  | 剪贴板 IPC 往返 | 写入成功，`clipboard.readText()` 读回一致 ✅ |
  | 真实请求（故意用假 key） | **HTTP 401** + `Authentication Fails` ✅ —— 说明请求真的出得去 |
  | 思考类名开关 | 加上 / 移除都正常 ✅ |
  | 立绘 `src` | 全程 `assets/pet-character.png`，**没被动过** ✅ |
  | CSS 是否真的加载 | `body` 计算样式 `overflow: hidden`、气泡宽度实测 `300px` ✅ |
  | 渲染进程 console error | **0 条** ✅ |

- 这一轮修掉的真实问题（详见 `ERROR_LOG.md` #9–#13）：
  CSP 少 `connect-src`、动画吞掉 `scale(1.1)`、`[hidden]` 被 `display:flex` 压过、
  视图切换后没重测气泡导致内容点不动、测试里 mock 定时器不自动跑导致复制按钮卡死。

### 交付物（AI 生成）
- `outputs/phase3-guide.md` —— 按 **C1–C15** 逐条的验收指南：每条写清「怎么操作 / 应该看到什么」，
  外加 API Key 申请步骤、7 条真实踩坑的排错表、AI 已验证与未验证的分界、Human-only Gate 与已知限制。
- `outputs/phase3-preview.html` —— **自包含预览页**（154.6 KB，双击即开，不用装 Electron 也不用 key）。
  它不是重画的假界面：真实的 `style.css` + `renderer.js` + 立绘（转 base64）被内联进同一个文件，
  所以悬停高亮、单击开合、拖拽跟随、齿轮切设置页、未配置 key 的提示、Markdown 渲染**都是真代码在跑**。
  三处必要改动（内联、data URI、CSP 放宽 `unsafe-inline`）都写在页面顶部的说明卡里。
  由 `.deepworks/tmp/make-phase3-preview.mjs` 生成（读源文件 → 替换外链 → 追加预览专用假桌面与说明卡），
  生成后自检 10 项全通过（含「无残留外链」「`<html>`/`<body>` 各只出现一次」）。

### 预览页的真机自检（`.deepworks/tmp/e2e-preview.js`）
在隐藏的 Electron 窗口里加载预览页，**故意不加载 preload**（这正是浏览器里打开它的处境），
按真人的操作顺序派发真实鼠标事件：

| 操作 | 结果 |
| --- | --- |
| 说明卡 / 假桌面是否渲染 | ✅ 都存在 |
| 立绘是否内联 base64 | ✅ 是（自包含） |
| `renderer.js` 是否真的在执行 | ✅ 角色被摆到右下角 `translate3d(668px,400px)`，并打印 `Phase 3 ready` |
| 悬停角色 | ✅ `body.interactive` 生效 |
| 单击角色 | ✅ `body.bubble-open` 生效，气泡定位到 `(560px,213px)` |
| 点齿轮 | ✅ 切到设置页（聊天页 `hidden=true`） |
| **未配置 key 时发送** | ✅ 出现「要先给大肥鱼买白饭吃的饭卡（API key）呦～」，**且没有发出任何请求** |
| 发送后输入框清空、按钮回到禁用 | ✅ 预期行为 |
| console error | ✅ **0 条** |

> 自检脚本自己也踩了两个坑（顺手记一下，省得下次再绕）：
> `interactive` / `bubble-open` 是加在 **`body`** 上的，不在 `#pet` / `#bubble` 元素上；
> 角色开气泡走的是 **`mousedown` + `window` 上的 `mouseup`**（为了区分单击和拖拽），
> 只派发一个 `click` 是打不开的。另外命中检测监听在 **`window`** 上，事件要派发到 `window`。

### 下一步（**需要你亲手做**）
- 申请自己的 DeepSeek API Key 填进设置页（AI 不会也不能替你申请）。
- `npm start`，按 `outputs/phase3-guide.md` 的 **C1–C15** 逐条验收，
  并用 **3 个真实问题**跑通，然后故意制造一次真实错误写进 `ERROR_LOG.md`。
- 已知未修（本阶段刻意不动）：换显示器后窗口尺寸 / 位置不重算，
  仍留作后续修（`screen.on('display-metrics-changed')`）。

---

## 附带任务（非 Phase 计划内）：角色照片修复

用户另给了一张 195×230 的低清角色照（头顶铁盆 + 围裙 DeepSeek 鲸鱼图标），要求变清晰、抠成透明、
保留图标不变形，成果留作以后用。**未改动本项目任何源码**，只新增 `outputs/` 成品与 `tools/photo-restore/` 脚本。

- 方案：Real-ESRGAN anime 6B（ONNX）**先** 4× 超分 195×230 → 780×920（CPU 1.6s），
  再 isnet-anime 抠图（`threshold 0.5 / feather 1.2 / shrink 0.06`，柔边）。
  顺序不可颠倒：抠图模型只吃 RGB，喂 RGBA 会丢 alpha。
- 关键取舍：**柔边 + 阈值偏移收缩** 优于硬二值 + MinFilter —— 后者会留 1px 背景混色带并造出台阶。
  缩放透明图走 premultiply，否则半透明边缘会把背景色混进来形成灰边。
- 验证：图标 7 倍特写确认鲸鱼形状按原结构重建未变形；铁盆完整；透明图四角 alpha=0；
  连通域检查孤立背景碎片 **0**；白/深/灰三底合成均干净；预览页真机自检 8 项通过、console 0 报错。
- 成品：`outputs/pet-photo-4x-clear.png`、`pet-character-cutout.png`(662×788)、
  `pet-character-512.png`、`pet-character-256.png`、`photo-fix-preview.html`、`photo-restore-notes.md`。
- 坑：Hugging Face 直连大文件会被 CDN 截断成 16~17KB 残件（本次两个模型都遇到过，靠文件长度校验才发现）；
  改从 GitHub Release 下 168MB 的抠图模型速度正常。
- 待用户决定：是否把 `pet-character-256.png` 覆盖到 `src/assets/pet-character.png`（**AI 没有动这个文件**）。

### 追加：三视图 → 正面透明立绘

用户又给了一张 2048×1152 的三角色三视图（正面/侧面/背面，近纯白背景），要求截取正面并去掉背景。

- 定位靠数据：按非白像素列直方图分连续段得 正面 x 269–672 / 侧面 825–1300 / 背面 1364–1765，取正面按包围盒 +14px 裁切（432×1144）。
- **关键判断**：背景虽近纯白，但角色有白围裙、白袖、白长袜，**亮度阈值会把衣服抠穿**，必须用抠图模型；且细长图直接缩进固定的 1024×1024 会被纵向压扁，故先补白成正方形再推理（`cutout.py --pad`），mask 拿到后裁回。
- 验证：四角 alpha=0；内部空洞 2156px（0.47%）逐块定位确认全在**发丝缝隙与两腿之间**（应透明的区域），衣物上无穿孔；白/深/灰三底合成无白边黑边。
- 成品：`outputs/front-view-crop.png`(432×1144)、`front-view-cutout.png`(412×1116)、`front-view-512.png`、`front-view-256.png`。
- 新脚本：`tools/photo-restore/cutout.py`、`tools/photo-restore/square_fit.py`（同样未改动项目源码）。

## 2026-10-22 · Phase 3.5：思考深度 ↔ 三档立绘差分 + 动态画框

### 需求起点（先记一个事实，免得日后自欺）
用户说「改一下现在已有的下拉框」，但我先 `grep` 了一遍
（`深度|depth|reasoning|effort`）：**代码里根本没有这个下拉框**，
设置页只有 API Key。所以这不是「改造」，是**从零建一条链路** ——
下拉框、持久化、换图、尺寸联动，全部新写。

同时，Phase 3 白纸黑字写过的「禁止切换 `src` 的差分图」被用户的新需求推翻了。
我没有偷偷改代码了事，而是：
1. 把 `index.html` / `style.css` 里那句「永远不换图」的注释**改写**成新规则；
2. 在 `DECISIONS.md` 新增 **D10**（部分推翻 D9），把「为什么现在可以换图」写清楚；
3. 在 `PLAN.md` 的旧约束下面加一条指向 Phase 3.5 的说明 —— **保留原文**，不抹掉历史。

### 一、数据与持久化
- `DEPTHS = { low: {w:192,h:192,src:'./assets/pet-low.png',…}, high: {210×280}, max: {240×360} }`
  —— 尺寸和图片路径放在**同一张表**里，避免「换了图忘了改框」。
- 键：`localStorage['pet_thinking_depth']`，值 `low|high|max`。
- `readDepth()` 只认这三个值，别的（脏数据、null、抛异常）统统回落 `low`。
- `writeDepth()` 写完**立刻读回校验**：读不回来就说明这台机器存不住，
  状态行会说「本次生效，但没能记住」，而不是假装成功。

### 二、几何：`state.size`（单值）→ `state.box {w,h}`
原来所有位置计算都写死「96 / 192」这种半边与全宽，换成长方形必须逐处改：
`isPointOnPet`、`placeAtBottomRight`、`positionBubble`、`movePetTo` 全部改成
`box.w` / `box.h` 分开算；气泡箭头在 up / down 两种朝向下用的也是 `box.w`。
- 贴边 margin 仍是「画框尺寸的 5%」，但**上限按 240/360 算**，因为切换瞬间
  `scale(1.1)` 的溢出（360 高时单侧约 18px）必须被 margin 吃掉。
- 视口封顶：`BOX_VIEWPORT_LIMIT = {w:0.4, h:0.52}`，**必须**与 CSS 的
  `max-width: 40vw; max-height: 52vh` 一致 —— 两处不同步，JS 算出来的框
  会和实际渲染的框对不上，表现为「点不到角色」。测试里显式断言了这一对。

### 三、换档流程 `applyDepth()`（顺序很关键）
换图 → 改画框变量（`--pet-w` / `--pet-h` / `--tail-x`）→ **保住脚底中点**重摆 →
气泡重排 → 刷新穿透区 → 同步下拉框和状态行 → （可选）写盘。
- 「保脚底中点」是体感的关键：只改尺寸不重摆，角色会以左上角为锚点往上顶，
  看起来像被拽走。现在三档切换，脚底与投影纹丝不动。
- `init()` 里新增 **步骤 1.5**：在 `placeAtBottomRight()` **之前**就 `applyDepth(readDepth())`。
  顺序反了的话，会先按 192 摆一次、再按实际档位摆一次 —— 开场一帧可见的跳动。

### 四、两个真实踩到的坑
1. **CSP 没有 `'unsafe-inline'`，注入 `<style>` 直接被拒。**
   想在测试里关掉过渡只能走 CSSOM：`styleEl.sheet.insertRule(...)`。
   这个坑是 Electron 端到端自检里踩到的，不是猜的。
2. **隐藏窗口会节流 CSS 过渡。** `#pet { transition: width/height .18s }`
   在 `win.hide()` 的窗口里不推进，`getBoundingClientRect()` 读到的是旧值，
   测试就会误报「尺寸没变」。解法：测量前 `insertRule('#pet{transition:none !important}')`
   再强制一次 `offsetWidth` 同步布局。

### 五、验证（数字说话）
- 回归：`node .deepworks/tmp/test-renderer.mjs` → **190 通过 / 0 失败**
  （新增「场景 D」42 条：默认档、换档换图、写盘读回、`--tail-x`、脚底不动、
  新框命中、气泡重排、思考中换档类名保留、小屏封顶 200×208、脏值兜底、
  重启恢复、localStorage 不可用降级）。
- 端到端（真实 Electron 窗口）：三张图 `naturalWidth` 均 256；初始 low / 192×192；
  切 max 后 `src=./assets/pet-max.png`、`rect 240×360`、`--pet-w/h=240/360px`、
  `stored=max`、思考中类名保留；命中测试 240×360 全中、底部右侧均未出屏；
  测完复原用户原档位。`problems: []`。
- 视觉：设置页截图排版正常（自绘下拉箭头、状态行 274×34）；
  用真实九头身立绘临时占位截图，确认 240×360 里立绘不超屏、脚贴地、尾巴对准中线。

### 六、诚实的偏离与限制
- **偏离**：下拉框 `change` 即生效即保存，不等「保存」按钮（按钮仍然只管 API Key）。
  理由：这类即时预览型控件，等保存会让人觉得「选了没反应」；反过来，
  选了却不存，下次启动又变回去更容易挨骂。
- **限制**：三张占位图现在都是同一张 Q 版（`pet-character.png` 的副本），
  所以三档在视觉上只差「画框大小」。真实差异要等用户覆盖同名文件。
- **限制**：方形立绘塞进 240×360 竖框时 `contain` 会留白；已加
  `object-position: 50% 100%` 让图贴底，但根治办法是**紧裁到 alpha 边界**。

## 2026-10-22 · Phase 3.6：思考深度真正接入请求（chat ↔ reasoner）

### 起点：被问到「这按钮不是摆设吧」
上一轮的实现里，下拉框确实只换立绘，请求永远 `deepseek-chat`。
所以「轻量 / 标准」对答案没有任何影响 —— 用户追问「能不能真的影响思考」，
答案是「现在不能」，然后被要求做出来。这条要写清楚，别把补救说成新功能。

### 关键事实：DeepSeek 没有 `reasoning_effort`
先确认参数表：Chat Completions 只有 model / messages / temperature / max_tokens / stream …
没有 OpenAI o 系列那种「思考档位」。所以「三档思考」只能靠三根杠杆组合：

| 杠杆 | 做法 |
| --- | --- |
| 模型 | 轻/标准 `deepseek-chat`，极致 `deepseek-reasoner`（真会先推理） |
| 预算 | 600 / 1600 / 16000 tokens（reasoner 的推理 token 也算在里面，所以给足） |
| 提示 | system 末尾追加「本次回答的详细程度」要求（三句话内 / 结论+要点 / 先完整推演） |

`temperature` 只在前两档出现：**reasoner 不接受采样参数，带上去直接 400**，
所以拼请求时按档位判断「有没有这个字段」，而不是发出去再兜错。

### 一、请求层
- 新增 `buildPayload(text, depth)`：唯一生成请求体的地方，测试可以直接断言它。
- `requestDeepSeek` 在**发请求那一刻**把档位钉住（`depthAtSend`）：
  用户中途换档，不能让 reasoner 的结果被当成 chat 的结果展示。
- 超时按档位取：前两档 60s，极致 180s；报错文案里的秒数也跟着档位走
  （之前写死「60 秒」，极致档会把用户吓一跳）。
- 解析响应时多读一个 `reasoning_content`（只有 reasoner 有）。
  新增一个边界：**只有推理、没有正文**时给专门文案，不能当成功。

### 二、展示层
- `appendReasoning()` 用 `<details>` 折叠块，标题「思考过程 · N 字（点开看）」，
  内容一律 `textContent`（模型输出不是可信 HTML），默认收起。
- 发送时的状态提示按档位变：极致档是「正在深度推理…（极致档会多想一会儿）」。

### 三、两个只有截图才能发现的布局坑
1. **展开后「看不到推理」**：消息区是固定高度内部滚动的，details 展开只是把
   内容长到视口外。修法：`toggle` 时按**rect 差值**把这块滚到顶部 ——
   一开始用 `offsetTop`，结果多滚了一个标题的高度（`offsetTop` 相对 offsetParent，
   消息区不是定位元素）。这个差值是截图里「摘要行不见了」暴露出来的。
2. **最后一行被切一半**：`max-height: 132px` 配上 `line-height: 1.65`，
   正好在行中间断开。改成 `line-height: 18px` + `max-height: 124px`
   （124 − 16 padding = 108 = 6 行），切边问题消失。

### 四、验证
- 单测：**214 通过 / 0 失败**。新增「场景 E」24 条，覆盖三档请求体的
  model / max_tokens / temperature 存在性 / system 尾注、超时 60s 与 180s、
  思考过程渲染在回答之前、只有推理无正文的文案、在途请求不被换档影响。
- 真实窗口（stub fetch，不打真实网络）：抓到的三档请求体分别是
  `chat/600/0.6`、`chat/1600/0.35`、`reasoner/16000/无 temperature`；
  `.msg-think` 真的渲染、展开后消息区 scrollHeight 435 → 477；`problems: []`。
- 截图：极致档展开态可读（6 行推理 + 上下滚动），回答紧随其后。

### 五、诚实的限制
- 三档差异的**本质是「换了模型」**，不是「同一个模型想得更久」；
  文档与答辩口径都要这么说，否则就是错的。
- 极致档更贵更慢；推理 token 也计费。日常用轻量/标准更划算。
- 推理过程不进历史（回传会让 reasoner 400），多轮追问时它只看到自己上轮的结论。
- 没做流式：极致档的等待是「一次性变长」，没有逐字/逐句的推理直播。
  真要做推理直播得改 `stream: true`，那是另一件事。

## 2026-10-22 · Phase 3.7（三档立绘替换 + 变身动画）

### 完成事项
- [AI-GEN] 立绘替换：`pet-high.png` = `pet-character-cutout.png`（662×788，戴饭盆的 Q 版），
  `pet-max.png` = `front-view-cutout.png`（412×1116，九头身）；`pet-low.png` 保持原样。
- [AI-GEN] 变身动画（`renderer.js`）：`runMorph()` 两段式 —— 收起 170ms → 暗场换图/换框 →
  弹出 330ms；`.pet-core` 由 WAAPI 驱动，不碰 `<img>` 自己的呼吸/摇摆。
- [AI-GEN] 稳定性：`preloadSprite()` 预解码下一张图（避免换图闪空）；
  `settleAnimation()` 定时兜底 + `cancel()`（窗口被节流时也不至于卡在半透明）；
  `cancelMorph()` + `morphSeq` 让连点切换只保留最后一次。
- [AI-GEN] 降级：`prefers-reduced-motion` / 无 WAAPI / 启动恢复 → 直接换图。
- [AI-GEN] `style.css`：`.pet-core { transform-origin: 50% 100% }`（缩放钉住脚底）+
  `body.transforming .pet-core::before` 的 `morph-halo` 光晕扩散。
- [AI-GEN] 测试：`test-renderer.mjs` 新增场景 F（25 条），总数 214 → **239 通过 / 0 失败**。

### 遇到的问题
| 问题 | 状态 |
| --- | --- |
| 隐藏窗口里 WAAPI 卡在中间帧，e2e 读到 `opacity: 0`、`transforming` 摘不掉 | ✅ 自检脚本加 `webContents.setBackgroundThrottling(false)`；产品代码里另有定时兜底 |
| 连点切换时两个 `runMorph` 会互相覆盖 `src` | ✅ `cancelMorph()` + 序号校验，只有最后一次能走到换图 |
| 换图瞬间会先露出空画框 | ✅ 收起的同时并行 `decode()` 下一张，等它好了再换 |
| 先换画框会让旧立绘被拉变形 | ✅ 画框与 `src` 放在同一帧（暗场）执行 |
| 定时兜底与真动画的先后不确定 | ✅ 兜底先到就 `cancel()`，回归基准样式而不是停在半透明 |

### 下一步
- 人工验收：三档观感是否「越深越完整」；变身节奏是否偏慢/偏快；极致档立绘是否偏窄。
- Phase 4：会话持久化 / 多轮上下文裁剪。

## 2026-10-22 · Phase 3.8（变身动画放慢 + 旧图退场/新图淡入）

### 完成事项
- [AI-GEN] `MORPH_OUT_MS` 170 → **380**，`MORPH_IN_MS` 330 → **460**（总时长约 0.84s）。
- [AI-GEN] 旧图改为「上浮退场」：`translateY(0 → -8px)` + `scale 1 → 0.97` + 淡出，
  缓动用 `ease-in`（主动离开）；新图改为纯「淡入」：从下方 10px 归位，`ease-out`。
- [AI-GEN] 去掉弹出过冲（1.025），只保留很轻的 0.985 → 1 缩放，避免又变回「弹跳」。
- [AI-GEN] 修换图时序：换 `src` 时旧动画的 `fill: forwards`(opacity 0) 仍然压着，
  新图动画建好后才 `cancel()` 旧动画，杜绝「cancel 先恢复不透明 → 闪一帧旧图」。
- [AI-GEN] 光晕 `morph-halo` 620ms → 900ms，盖住整段动作。
- [AI-GEN] 测试：场景 F 断言同步更新（380/460/合计 840/上浮终点/淡入中间帧），
  总数 239 → **242 通过 / 0 失败**；e2e 等待时间放宽到 1.5s。

### 遇到的问题
| 问题 | 状态 |
| --- | --- |
| `out.cancel()` 放在换 `src` 之前，旧图会闪一帧不透明 | ✅ 换图 → 建新动画 → 再 cancel |
| 截图逐帧看不清真实曲线（capturePage 有明显延迟） | ✅ 改用页面内每 50ms 采样 computed opacity |
| 旧截图目录里混着上一轮的帧，拼图顺序错乱 | ✅ 新截图用 `morph2-` 前缀并按毫秒排序 |

### 实测时间线（毫秒 / opacity）
`1→1.00 104→0.90 206→0.61 308→0.21 359→0.05 410→0.25(新图) 512→0.84 665→0.99 716→1.00 868→摘除 transforming`

### 下一步
- 人工确认 0.84s 的节奏（想更慢可到 1.0–1.1s，改两个常量即可）；
- Phase 4：会话持久化 / 多轮上下文裁剪。

## 2026-10-22 · Phase 3.9（System Prompt 换成鲸鱼娘正式版）

### 完成事项
- [AI-GEN] `SYSTEM_PROMPT` 整体替换为用户提供的正式人设，逐字（751 字 / 21 行），
  保留【核心性格】【对话风格】【场景反应示例】的分段与空行。
- [AI-GEN] 注释同步：标明「逐字使用、不要改写、模板字符串换行即原样换行」。
- [AI-GEN] 测试新增 5 条人设哨兵（签名句、核心段落、示例段、旧占位不得残留、长度下限），
  总数 242 → **247 通过 / 0 失败**。
- [AI-GEN] 深度档尾注（`【本次回答的详细程度】`）保持不变 —— 它属于 3.6 的请求参数层。

### 遇到的问题
| 问题 | 状态 |
| --- | --- |
| 人设要求「不超过两三句话」，与极致档「给步骤/推演」冲突 | ⚠️ 保留两层：人设管语气、尾注管信息量；若观感不好再收敛尾注 |
| 旧测试只断言 system 非空，改坏了也不会红 | ✅ 换成签名句 + 长度双重断言 |

### 下一步
- 人工试聊 3–5 轮：检查是否「嫌弃但不抛弃」、是否真的控制在 2–3 句、被叫「大肥鱼」是否炸毛。
- 若极致档回答被压得太短，再决定是否把人设的「两三句话」限定为闲聊场景。

## 2026-10-22 · Phase 3.10（修输入法候选词被遮）

### 完成事项
- [AI-GEN] 定位根因：窗口 `'screen-saver'` 层级盖住了输入法候选词面板（系统窗口，非 DOM）。
- [AI-GEN] `main.js`：新增 `setImeFriendly()` + IPC `pet:set-ime-friendly`，
  打字时 `setAlwaysOnTop(false)`，结束恢复 `screen-saver`；`win.on('blur')` 兜底恢复；
  BrowserWindow 显式补 `focusable: true`。
- [AI-GEN] `preload.js`：白名单新增 `setImeFriendly(on)`（6 → 7 个方法）。
- [AI-GEN] `renderer.js`：两个输入框 focus/blur 驱动该开关；切换输入框延后判断；
  收气泡、窗口 blur 无条件关闭。
- [AI-GEN] `style.css`：`.bubble-inner` 底部 padding 12 → 16，显式 `overflow: visible`。
- [AI-GEN] 测试：单测 247 → **255 通过 / 0 失败**；e2e 新增 `ime` 探针
  （focused → `alwaysOnTop:false`，blurred → `true`），`problems: []`。

### 遇到的问题
| 问题 | 状态 |
| --- | --- |
| 一开始想用 `focusin` 委托，但 mock 不冒泡，且 `focus` 本身不冒泡 | ✅ 直接绑到两个输入框 |
| 降层级后桌宠会被别的窗口压住 | ✅ 只在打字期间；失焦/收气泡立刻恢复 |

### 下一步
- 用真机拼音输入法验收一次（自动化无法绘制系统候选词面板）。

## 2026-10-22 · Phase 3.11（气泡标题改名）

### 完成事项
- [AI-GEN] `index.html` 标题默认文本 `DeepSeek` → `吃白饭的大肥鱼`。
- [AI-GEN] `renderer.js` 里 `setPanel()` 的复位值同步改掉（否则从设置页返回会变回旧名）。
- [AI-GEN] 样式零改动：仍是 `.bubble-title`（12px / 600 / 品牌蓝 / 0.02em）。
- [AI-GEN] 测试断言同步；单测 **255 通过 / 0 失败**，e2e 标题读回新文案、`problems: []`。
- [AI-GEN] 截图验收 `outputs/phase3.11-title.png`：标题宽 86px，不挤压齿轮。

### 遇到的问题
| 问题 | 状态 |
| --- | --- |
| 只改 HTML 时，进出设置页会变回 `DeepSeek` | ✅ 两处一起改 |

## 2026-10-22 · Phase 3.12（本地记忆 + 好感度 + 桌面控制）

### 完成事项
- [AI-GEN] **记忆**：`chat_history` 存 `{role, content}`；本地最多 40 条（20 轮），
  注入只取最近 10 条（5 轮）；`buildPayload()` 用它拼 `messages`，重启后仍在。
- [AI-GEN] **好感度**：`favor` 初始 50、范围 0–100，每成功聊一轮 +1；
  以「系统隐藏设定」整段拼进 system（在人设之后、深度尾注之前）。
  失败 / 超时 / 没 key 都不加；请求体用的是**涨之前**的值。
- [AI-GEN] **清空记忆**：设置页新增「清空聊天记忆」，只清 `chat_history`，
  好感度保留；同时清空气泡日志并追加一条 notice，避免「记录清了、屏幕还挂着」。
- [AI-GEN] **设置页信息行**：`记忆 N 条 · 好感度 M/100`，每轮成功与清空后即时刷新。
- [AI-GEN] **边缘吸附**：拖拽松手时距屏幕边 < 30px 就贴边（260ms 过渡）；
  只对拖拽生效，单击不吸附；`prefers-reduced-motion` 下直接贴边。
- [AI-GEN] **系统托盘**：`assets/icon.png`（由立绘缩放 64×64，托盘显示 18×18），
  右键「显示/隐藏桌宠」「退出程序」；隐藏前先关 IME 友好模式，
  再显示时恢复置顶 + 全工作区可见 + 鼠标穿透。
- [AI-GEN] 测试：单测 **291 通过 / 0 失败**（场景 I：IME；场景 J：记忆/好感度/吸附）；
  e2e 新增 `memory` 探针，实测 `msgCounts [2,4,6]`、`favorInjected [50,51,52]`、
  落盘 `favor=53`、清空后 `history=0` 但 `favor=53`、`snapToZero=true`，`problems: []`。

### 遇到的问题
| 问题 | 状态 |
| --- | --- |
| e2e 里先点「清空」再测推理折叠块，导致断言拿到空日志 | ✅ 调换顺序：先测渲染，再点清空 |
| 测试脚本把 `favor`/`chat_history` 写进真实用户目录 | ✅ 收尾统一 `removeItem`，复查四项存储均为 `null` |
| 托盘图标只给 64px 源图，Retina 下略糊 | ⚠️ 可接受；要更清晰直接换 128/256px 源图，代码会缩到 18 |

### 下一步
- 人工验收：真机拼音输入法、托盘显示/隐藏、拖到屏幕边松手、聊两轮后重启看记忆是否还在。
- 若觉得「每轮 +1」太慢，改 `FAVOR_PER_CHAT` 一处即可。

## 2026-10-22 · Phase 3.12 补丁（缩小标准 / 极致立绘）

### 完成事项
- [AI-GEN] `DEPTHS.high` 210×280 → **190×250**；`DEPTHS.max` 240×360 → **210×315**。
  轻量档 192×192 不动。画框缩小后立绘按 `contain` 等比缩，命中框、投影、
  气泡尾巴偏移（`--tail-x` 107px → 92px）全部跟着算，不需要额外改 CSS。
- [AI-GEN] 同步设置页下拉框文案、`--pet-w/--pet-h` 注释、`#pet` 过渡注释。
- [AI-GEN] 单测期望值跟随更新（画框 / CSS 变量 / 尾巴偏移 / 命中点），
  **291 通过 / 0 失败**；e2e 实测 `rect 210×315`、`rendered 231×347`（scale 1.1 后）、
  `hitTest.bottomInside/rightInside` 均为 true，`problems: []`。
- [AI-GEN] 三档对比图：`outputs/phase3.12-sprite-sizes.png`。

### 遇到的问题
| 问题 | 状态 |
| --- | --- |
| 旧单测在「画框底部 y+340」处断言命中，缩小后该点已落到框外 | ✅ 改成 `y+296`（新框内、旧方框外） |
| 尾巴偏移写死 107px 的断言 | ✅ 公式不变，期望值改 92px |

### 下一步
- 人工看一眼实际桌面上三档大小是否顺眼；还想更小/更大只改 `DEPTHS` 两个数字。

## 2026-10-22 · Phase 3.13（好感度养成化）

### 完成事项
- [AI-GEN] **数值隐藏**：`updateMemoryStatus()` 只写 `记忆 N 条`；index.html 首帧文案、
  清空按钮 title、清空后的 notice 全部去掉「好感度」字样；无进度条、无数字。
- [AI-GEN] **讨好暴击**：`FAVOR_BOOST_WORDS`（白米饭 / 红烧肉 / 大肥鱼真棒 / 辛苦了 / 投喂）
  命中 +10，多个词命中仍只 +10；`includes` 匹配，不做分词。
- [AI-GEN] **自然衰减**：未命中 -1；`settleFavorForMessage()` 在 `onSend()` 里、
  发请求之前结算并 `writeFavor()`，本次请求的 system 立刻用新值。
- [AI-GEN] **边界**：沿用 `clampFavor()`，0–100 双向夹紧。
- [AI-GEN] **四档联动**：`favorTier()` → 极度烦躁(<30) / 日常嫌弃(30–59) /
  日常傲娇(60–84) / 傲娇巅峰(≥85)；`favorSystemBlock()` 注入数值 + 档位 + 语气要求，
  并明确「不要在回复里提到好感度、数值、档位」。
- [AI-GEN] 删掉旧的「每成功一轮 +1」（`FAVOR_PER_CHAT` 已移除）。
- [AI-GEN] 测试：新增场景 K（讨好/叠加/上下限/四档边界/无 key 不结算/界面不泄漏），
  单测 **315 通过 / 0 失败**；e2e 实测 `favorInjected [49,48,47]`、`favorStored 47`、
  `statusText 记忆 6 条`、清空后 `记忆 0 条` 且 favor 不变，`problems: []`。

### 遇到的问题
| 问题 | 状态 |
| --- | --- |
| 旧断言认为默认 50 是「傲娇」 | ✅ 按需求 30–59 是「日常嫌弃」，默认 50 就该是嫌弃 |
| 旧 e2e 用 `【系统隐藏设定】` 精确匹配 | ✅ 文案加了「· 只在后台生效」，断言改为前缀匹配 |
| 清空按钮 title / notice 还在提「好感度」 | ✅ 一并删掉，避免从 UI 泄漏系统存在 |

### 下一步
- 人工连发 4 次讨好词 + 6 句普通对话，确认四档语气的落差够明显。
- 若「傲娇巅峰」太难到，可把 `FAVOR_BOOST_DELTA` 调到 15；不建议改分档边界。

## 2026-10-23 · Phase 3.14（右键查余额）

### 完成事项
- [AI-GEN] `#bubble` 新增第三个视图 `#view-wallet`（`#wallet-text` + 一行提示），
  和聊天/设置视图用 `hidden` 互斥；`setPanel()` 支持 `'wallet'`。
- [AI-GEN] `#pet` 绑定 `contextmenu`：`preventDefault()` + `stopPropagation()`，
  立刻打开气泡并显示「（翻找钱包中...）」，再 `GET https://api.deepseek.com/user/balance`。
- [AI-GEN] 三分支文案：成功 `¥110.00`（读 `balance_infos[0]`，兼容顶层字段）/
  没 key `连钥匙都没给我…`（不发请求）/ 网络或 HTTP 错误 `网络出问题了…`。
- [AI-GEN] 无自动关闭定时器：加载态停留 6 秒仍不消失；只有 10 秒请求超时会把加载态换成报错。
- [AI-GEN] 左键语义：钱包开着时点球 → 切回聊天并聚焦输入框；关气泡时 `resetWalletView()` 退回聊天。
- [AI-GEN] 连点右键用 `state.balanceSeq` 丢弃过期结果；查询不写记忆、不动好感度。
- [AI-GEN] 测试：新增场景 L（preventDefault / 加载态 >5s / 成功 / 无 key / 401 / 网络异常 /
  连点竞态 / 左键切回 / 关气泡复位 / 币种格式化 / 静态结构），单测 **362 通过 / 0 失败**；
  e2e 实测 `defaultPrevented true`、`loadingText（翻找钱包中...）`、
  `resultText …¥110.00…`、`call GET + Bearer`、左键后 `inputFocused true`、
  无 key `newCalls 0`，`problems: []`。
- [AI-GEN] 截图：`outputs/phase3.14-wallet.png`。

### 遇到的问题
| 问题 | 状态 |
| --- | --- |
| 全局已有 `window.contextmenu` 拦截，担心右键收不到 | ✅ 拦截只 `preventDefault` 不 `stopPropagation`，`#pet` 的监听照常先触发 |
| 聊天框聚焦时右键，输入法会挂在钱包视图上 | ✅ `focusPanel()` 在 wallet 分支里 blur 输入框并退出输入法友好模式 |
| 气泡在隐藏状态下 `measureBubble()` 会量到 0 | ✅ `closeBubble()` 用不测量的 `resetWalletView()` 复位视图 |
| 连点右键时旧请求可能盖掉新文案 | ✅ `balanceSeq` + `state.panel` 双重校验，过期结果直接丢弃 |

### 下一步
- 用真实 key 点一次右键，确认 `¥` 金额与官网余额一致；余额为 0 时也应显示 `¥0.00`。
- 若想让加载态更久/更短，只改 `BALANCE_TIMEOUT_MS`（默认 10 秒）。
