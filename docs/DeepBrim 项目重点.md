# DeepBrim 项目重点（v3）

> 来源：
> - 对话一 <https://chat.deepseek.com/share/uwytbdme2t9glx6e6w>
> - 对话二 <https://chat.deepseek.com/share/7d3ggrz4gvcvxiq7wy>（分享页仅含用户提问，AI 回复由用户补充粘贴）
>
> 更新：2026-10-28 ｜ 版本：v3（并入现场抓包验证：官方真值字段、附件用量、请求体结构）
> 说明：本文只归并重点与定案，不含实现代码。

---

## 一、项目定义

**DeepBrim** —— 一个专为**网页版 DeepSeek（chat.deepseek.com）** 做的 **Edge 浏览器扩展（MV3）**，用一块可拖拽的悬浮窗实时显示 Token 用量与上下文占用。

一句话定位：

> A minimal, native Edge extension that shows exactly how much context you've used on chat.deepseek.com.
> 看看你的杯子还剩多少空间。

目标平台已从「通用浏览器」收窄为 **Edge**。

---

## 二、已确认的硬事实

| 事实 | 结论 | 影响 |
|------|------|------|
| 网页版是否有 usage 字段 | **已实测确认**：SSE 中存在 `accumulated_token_usage`（末帧 20812），附件事件带 `token_usage`；此前"不保证"的推断被推翻 | 真值成为主路径，估算降为兜底 |
| 网页版上下文上限 | **1M（百万 Token）**，网页端/App 端均已支持，底层 V4.1 Flash，原生 100 万上下文 | 分母改为 1M，产品定位整体重估 |
| 网页版 tokenizer | 官方未公开 JS 版，与 tiktoken 不同源；中文偏差约 10–20% | 不影响主路径，仅在兜底估算时使用 |
| 历史数据接口 | 社区已验证 `GET /api/v0/chat/history_messages`、`GET /api/session.export?sessionId=<id>&includeDescendants=true`；Bearer Token 存在 localStorage | 历史追溯可行，无需用户粘贴 |
| Edge 内核 | 基于 Chromium，MV3 规范与 Chrome 一致，`chrome.*` API 可直接用 | 兼容性包袱可卸下 |
| 同类产品 | `tokcount`（Chrome/Firefox/Edge 三端，live token + 估算费用 + context meter）、`dsh-composer-tokens`、Headroom、TokenScope、ai-chat-context | 路已走通，差异化必须做在「总量 + 历史 + 不归零」 |
| 命名 | `DeepBrim` 无直接竞品；只有一个不相关的 PyPI 包 `deepagents-brim` | 可用，仓库名建议 `deep-brim` |

### 抓包验证（2026-10-27 实测）

| 发现 | 证据 | 结论 |
|------|------|------|
| 累计用量 | `accumulated_token_usage` 出现在响应对象中；末帧为 `data: {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":20812},{"p":"quasi_status","v":"FINISHED"}]}` | 直接读取即绝对真值，无需估算 |
| 附件用量 | `event: update_file` + `data: {..., "token_usage":964}`（2500×3684 图片）；txt 文件 1614 | 监听事件累加即可，不必本地解析附件 |
| 请求体 | 只传 `ref_file_ids: ["file-..."]`，不含 base64 / 全文；`chat_session_id` 明文给出 | 缓存 key 直接用 `chat_session_id` |
| 响应类型 | `Content-Type: text/event-stream; charset=utf-8` | clone 流解析方案成立 |

---

## 三、产品定位（1M 时代的转向）

- **原定位**：防止长对话被硬截断。
- **新定位**：用量透明化 + 历史追溯 + 跨对话不归零。

推论：
1. 1M 下进度条长期停在绿色区，"防截断预警"价值下降。
2. 真正价值是三件事：**看得见真实消耗**、**补得回装插件前的历史**、**切对话不丢数**。
3. ±20% 误差在 1M 下约等于 ±200K，所以必须标明数据来源（接口 / 估算）与估算符号 `~`。

---

## 四、平台与技术底座（Edge / MV3）

### 四条硬限制与应对

| 限制 | 说明 | 应对 |
|------|------|------|
| **world 隔离** | content script 在 isolated world，覆盖不了页面 `window.fetch` | 直接在 manifest 里给 content script 配 `"world": "MAIN"`（已采用，比 scripting 注入简单）；页面理论上可检测干扰，DeepSeek 不太可能反制 |
| **MV3 禁用阻塞式 webRequest** | 不能用 webRequest 阻塞监听 | 本需求是**被动读取**，在 MAIN world hook `fetch` / `XHR` 即可；httap 等扩展已验证可行 |
| **存储配额** | `storage.local` 约 5MB、`storage.session` 10MB、IndexedDB 极大 | **V1 只存数字 → `storage.local` 足够**（每对话约 100 字节，5MB ≈ 5 万对话）；要缓存原始消息才上 IndexedDB + `unlimitedStorage` |
| **Service Worker 30 秒休眠** | 后台被终止会中断 SSE 读取 | 拦截逻辑放 **MAIN world**，SW 只做消息中转 / 闹钟唤醒，不承担长连接 |

### 架构分层

```
拦截层（MAIN world）  hook fetch + XHR → tee() 复制流 → 解析 SSE / 读 usage → 估算
存储层（content + storage.local） 按 conversationId 存 baseline + increment
展示层（Shadow DOM） 圆盘 / 竖条 / 横条 收起态 + 统一展开面板
配置层（Options 页） 上下文上限预设 / 自定义、形态与阈值
后台（SW） 仅消息中转、唤醒
```

- 悬浮窗必须放 **Shadow DOM**，否则被页面全局 CSS 污染。
- 可选框架 **WXT**：已封装 MV3 的 MAIN world 注入与跨环境消息，能省事（非必需）。

---

## 五、开源项目调研（可抄的作业）

| 项目 | 做法 | 可借鉴点 |
|------|------|----------|
| **TokenScope**（vvvvking/tokenscope） | 页面脚本运行前注入 MAIN world 小钩子，monkey-patch `fetch` / `XHR`；`tee()` 复制响应流，一份还页面、一份静默解析 | **拦截层标准做法**；从 JSON 或**最后一个 SSE chunk** 取 `usage`，取不到就估算并标 `~` |
| **ChatGPT Counter** | Page-World 注入 | 验证「最难的是拦截而不破坏页面」 |
| **ajax-hooker** | 库级深度劫持 XHR / fetch，支持 SSE、NDJSON chunk 级改写 | 不想造轮子可直接用 |
| **ai-chat-context** | tiktoken 本地计数；按 Free/Pro/Max 订阅计划区分上限 | 计划分档思路；阈值 70/90 可参考 |
| **Headroom** | 硬编码 DeepSeek 1M，自动检测 + 用户手动覆盖，覆盖 7 平台，侧边栏常驻 | **分母可覆盖**已被验证；但 **Edge 侧边栏有坑**：`sidePanel.setOptions({enabled:true})` 切回 AI 页面不会自动恢复，微软确认「按设计如此」 |
| **DSH 插件生态**（dsh-plugin-usage-cost、dsh-token-gauge、dsh-token-total、dsh-token-viewer、dsh-usage-statistics-panel） | 用量由宿主**回放整份会话日志（tokenUsage 投影）** 计算；或调内部接口拉历史 | **历史追溯**的可行路径；证明「装插件前的数据」不能只靠监听 |
| **deepseek-driver**（SDK） | 封装网页端完整 API，支持会话创建 / 列表 / 重命名 | 可直接拉历史会话 |

**结论**：拦截抄 TokenScope 的 `tee()`；追溯走内部接口静默回补；展示**避开 Edge 侧边栏**，用悬浮 HUD。

---

## 六、功能矩阵

### V1（先做扎实）

1. 单对话总量：当前对话已用 X / 分母，附百分比。
2. 口径拆分：**正文 / 思考（CoT） / 附件 / 剩余量**。
3. 双路径取数：优先接口 `usage` 字段，回退本地估算。
4. 历史追溯：初始化静默拉取 + 手动强制重拉。
5. 按对话 ID 缓存，**切对话不归零**。
6. 悬浮窗三形态（圆盘 / 竖条 / 横条），自由拖拽、位置记忆。
7. Options 页：上下文上限预设 + 自定义。
8. 左键刷新、右键展开面板。

### V2（暂缓）

9. **逐条 token 角标**：每条消息底部右对齐小字，`~` 表示估算，流结束才显示，默认关闭。
   - DOM 对应：顺序匹配为主，对不上就不标（**宁可少标，不可错标**）。
   - 虚拟滚动会回收节点，需 MutationObserver 补插。
   - 常驻角标工作量大、且是竞品已有功能，不构成差异化。
10. 趋势预测：近 N 轮平均消耗速率，推算还能撑几轮。
11. 侧边栏 / 历史看板（视反馈再定）。

---

## 七、统计口径（定死）

### 分母

- 预设：`1,000,000`（默认 1M）、`128,000`、`64,000`、`自定义…`
- 自定义范围：`1,000` – `10,000,000`，非法输入回退上次有效值或 1M。
- 按 1000 进制（1M = 1,000,000），不按 1024×1024，保留误差冗余。
- 配置存 `chrome.storage.local`，注入脚本启动时先读。
- 浮层需体现当前上限（如悬停提示「上限：1,000,000，可在设置中修改」）。

### 文本估算（零依赖）

```js
function estimateTokens(text) {
  if (!text) return 0
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length
  const rest = text.length - cjk
  return Math.ceil(cjk * 0.6 + rest / 3.5)
}
```

中文 0.6 token/字，其余 3.5 字符/token。**仅作断网 / 字段缺失时的兜底，主路径已改为读 `accumulated_token_usage`。**

### 附件（优先用官方真值）

| 类型 | 算法 | 精度 |
|------|------|------|
| 全部附件 | 监听 SSE `event: update_file`，取 `token_usage`，并用 `is_image` 区分图片 | **官方真值，零误差** |
| 兜底（流里没有 update_file） | 图片 600/张；其他文档 10KB ≈ 2,500 tokens | 粗估 |

- 实测：2500×3684 图片 = 964 tokens；txt 文件 = 1614 tokens。
- 请求体只带 `ref_file_ids`，不含附件内容，因此**不需要 hook `<input type=file>` / `drop`**。
- 面板附件行需标数量（如「附件 2.9K（2 图 · 1 文件）」），悬停展开明细。

---

## 八、交互与 UI 规格

### 悬浮窗

- **收起态**：圆环表示**真实百分比**（tokens / 分母），环内/环上显示百分比，环下显示绝对值（如 `12.3K`）。用户明确选择「老老实实算」，接受 1M 下环几乎不动，用 K 数提供体感。
- **左键**：刷新 / 校准，配轻微动效（数字闪一下或转半圈），给用户安全感。
- **右键**：贴边弹出统一主面板。
- **拖动 vs 点击**：按下记坐标，移动超过 **5px** 才算拖拽，否则算点击。
- **位置**：不做贴边吸附，自由悬浮；**每种形态各记一份 `{x, y}` 视口百分比**，切回时恢复。
- **面板**：点外部或 Esc 关闭。

### 三形态

| 形态 | 尺寸档位 | 收起态 |
|------|----------|--------|
| 圆盘（默认） | 40 / 56 / 72 | 环 + 百分比 + 底部 K 数 |
| 竖条 | 宽 8 / 12 / 16 | 竖向填充 + 底部小字 |
| 横条 | 高 6 / 10 / 14 | 横向填充 + 右侧小字 |

三种形态**只影响收起态**，展开面板统一；三档尺寸，不做无级缩放。

### 数值格式与配色

- 百分比：< 10% 保留一位小数（`1.2%`）；≥ 10% 取整（`23%`）。
- 绝对值：< 1000 原样；1000–999999 用 `12.3K`；≥ 1M 用 `1.2M`；悬停 / 面板显示完整精确数。
- 颜色：< 60% 绿、60–80% 黄、80–90% 橙、> 90% 红（1M 下主要起心理安抚作用）。

### 展开面板结构

```
上下文用量
─────────────────────
 当前对话： 15.2K / 1M (1.5%)
 正文：     8.2K
 思考：     4.1K
 附件：     2.9K（2 图 · 1 文件）
 剩余：     984.8K
─────────────────────
 数据：实时拦截 + 历史追溯（已缓存）
 刷新时间：14:23:05
─────────────────────
 [ 重新拉取历史 ]  [ 设置上限 ]
```

---

## 九、数据流与缓存（最容易出 bug 的地方）

### 核心公式

```
显示总量 = 缓存的历史基线 baseline + 持久化的实时增量 increment
```

只存基线会丢数据：刷新页面后实时拦截归零，屏幕上只剩旧的 12K，刷新前聊的几轮凭空消失。所以增量也必须持久化（debounce 2 秒写一次，最坏丢 2 秒数据，可接受；较真可改为每次立即写）。

### 对话切换检测

- DeepSeek 是 SPA，切对话 URL 变成 `chat.deepseek.com/a/chat/s/<conversationId>` 但不刷新。
- **监听 `history.pushState` / `replaceState`（或轮询 `location.href`）**，`conversationId` 直接从 URL 取，作为缓存天然 key。

### 完整链路

```
进入对话 → URL 变化 → 取 conversationId
  ├─ 缓存命中 → 显示「基线 + 增量」
  └─ 缓存未命中 → 静默调 history_messages → 估算 → 写缓存 → 显示

实时拦截到新请求 → 更新增量 → debounce 写缓存 → 更新显示

左键点击 → 强制重拉历史 → 覆盖基线 → 增量归零 → 写缓存
```

### 缓存策略

- **永不过期 + 手动刷新兜底**（推荐）：切对话零延迟；跨设备续聊导致偏差时由左键兜底。
- 可选 TTL 1 小时，但切对话会卡一下。
- key 优先用请求体里的 `chat_session_id`（实测可用），URL 里的 conversationId 作兜底。
- 每条记录：`{ baseline, increment, lastUpdated, messageCount }`，存 `storage.local`。

---

## 十、已定决策（checklist）

- [x] 平台：**Edge / MV3**，放弃通用浏览器兼容包袱。
- [x] 拦截：MAIN world hook + `tee()` 复制流，不破坏页面。
- [x] 取数：接口真值优先，本地估算兜底，估算值带 `~`。
- [x] 分母：预设 + 自定义覆盖，默认 1M，Options 页配置。
- [x] 定位：总量 + 历史追溯 + 切对话不归零（三点是差异化）。
- [x] 历史：初始化静默拉取，左键强制重拉。
- [x] 缓存：按 conversationId 存 baseline + increment，`storage.local`，debounce 2s。
- [x] 展示：悬浮窗三形态，环看真实百分比、字看绝对 K 数。
- [x] 文案：左键刷新、右键面板。
- [x] 附件：直接读 `update_file` 的 `token_usage`（实测图片 964、txt 1614），估算仅兜底。
- [x] 逐条角标：**V2 再做**，V1 不做。
- [x] 命名：**DeepBrim**，仓库 `deep-brim`。

---

## 十一、待确认 / 未决

- [x] ~~抓包验证 SSE 用量字段~~ → 已确认 `accumulated_token_usage` 存在，末帧 20812。
- [x] ~~抓包验证附件形式~~ → 请求体只传 `ref_file_ids`；附件用量由 `update_file` 事件给出。
- [ ] 1M 是理论值还是实测可用值？不同模型上限是否一致？
- [ ] 深度思考（CoT）token 是否计入上下文？（当前口径：计入，因占用窗口）
- [ ] 网页版是否主动裁剪历史？"上下文"是全部消息还是最近 N 轮？
- [ ] 与 tokcount / Headroom / TokenScope 的差异化表述（当前答案是「总量 + 历史 + 不归零」）。

---

## 十二、风险清单

| 风险 | 说明 | 应对 |
|------|------|------|
| 精度不可信 | 1M 下 ±20% ≈ ±200K | 接口真值优先；标数据来源；估算加 `~` |
| 内部接口变动 | `history_messages` / `session.export` 属逆向接口 | 降级读 DOM 已渲染消息本地估算；保留手动兜底 |
| 冷启动体验 | 老用户装上看到 0 | 自动历史追溯 + 「估算中」状态 |
| 缓存错乱 | key 冲突、并发写、刷新后状态不一致 | 以 conversationId 为唯一 key；单写队列；debounce |
| 页面改版 | 消息节点无稳定 ID，角标易错位 | 顺序匹配 + 对不上不标；V2 再上 |
| 隐私合规 | 读取会话与附件内容 | 全部本地计算，不上传、不落库 |
| 性能 | SSE 逐帧解析 + Shadow DOM 重绘 | 增量累加；UI 200ms 节流 |
| Edge 侧边栏 | 切回页面不自动恢复（官方按设计） | 不用侧边栏，用悬浮窗 |

---

## 十三、命名与品牌资产

- **名字**：DeepBrim（Deep = DeepSeek，Brim = 杯沿 / 快满了）
- **仓库名**：`deep-brim`
- **一句话**：`看看你的杯子还剩多少空间。`
- **图标意象**：**一只杯子，水面浮出鲸鱼尾巴** —— 杯子快满到杯沿，鲸鱼快溢出来。
  - 只做剪影，三个尺寸三套策略：
    - 128：杯 + 半杯水 + 鲸鱼尾鳍 + 水波（可带渐变）
    - 48：杯 + 鲸鱼剪影（只留背鳍和尾），去波纹
    - 16：只剩**杯沿弧线 + 尾巴 V 形**，其余全省
  - 配色：杯身深蓝、水面 / 鲸鱼亮蓝，白底，呼应 DeepSeek 品牌色。
  - 实现：手写约 30 行 SVG，再用工具导出 16 / 48 / 128 三套 PNG。

---

## 十四、下一步

1. ~~抓包~~ → 已完成，字段全部确认。
2. ~~建骨架~~ → 已建 `manifest.json` / `content.js` / `inject.js`（日志验证版：MAIN world hook `fetch` + `clone()` 解析 SSE）。
3. 在 Edge 加载解压扩展，发一条消息，确认控制台打印 `accumulated_token_usage` 且页面不卡。
4. 通过后接入 Shadow DOM 圆盘浮层，再补历史追溯与缓存。

---

## 十五、一句话总结

**DeepBrim 是 1M 上下文时代的 DeepSeek 网页版「杯沿仪表」**：MAIN world 拦截 + `tee()` 解析拿真值，取不到就本地估算；分母可预设可自定义；历史接口静默回补装插件前的消耗；按对话 ID 缓存保证切换不归零；用一块可拖拽的三形态悬浮窗，把"看不见的消耗"变成"看得见的杯沿"。
