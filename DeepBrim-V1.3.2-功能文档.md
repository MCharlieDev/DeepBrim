# DeepBrim V1.3.2 功能文档

> 版本：v1.3.2（manifest 同步）
> 平台：Microsoft Edge · Manifest V3
> 文档范围：仅记录 **v1.3.1 之后** 的增量改动
> 文档日期：2026-11-07

---

## 一、版本概览

v1.3.2 是一次**数据正确性 + 会话状态判定**的修复版本，不新增界面与设置。改动分三类：

1. 历史回补链路的四类缺陷：估算误覆盖、MERGE 空包误判、全量请求无超时、请求可连点
2. 新增“会话事实”多证据分类，精确区分**清过缓存的老对话**与**真正的新对话**
3. 接入 SSE 补丁结构解析，并对自动重连造成的重复校准、契约误告警做防护

另外顺手做了日志降噪，并新增 `timeout` 状态以区分“失败”与“无法确认”。

---

## 二、新老对话判定：会话事实分类

### 2.1 问题背景

v1.3.1 只能靠“本地有没有缓存”做二选一：

- 老对话被自动清除缓存后，点「重新拉取」会出现“该会话暂无历史数据”的误报
- 真正的空白新对话，则要空等 8 秒全量超时才收尾

### 2.2 会话事实

每个会话在内存中维护 5 个标量（不存储任何报文原文）：

| 字段 | 含义 |
|------|------|
| `hasCompletion` | 是否捕获过该会话的 completion 请求 |
| `historyCount` | 最近一次历史响应的消息条数 |
| `historyCtrl` | 最近一次历史响应的 `cache_control`（MERGE / REPLACE / 空） |
| `currentMessageId` | 最近一次历史响应的主线锚点 |
| `historyTitle` | 历史响应里的会话标题 |

任何历史响应（页面自身、增量、全量、落库校准）到达时都会更新这些事实；completion 在 fetch / XHR 任一通道被捕获时置 `hasCompletion = true`。

### 2.3 三分支判定

| 判定 | 依据 | 动作 |
|------|------|------|
| `history` | 消息数 > 0 / `current_message_id` 有值 / 有效标题 / `MERGE` / 曾发过消息 / 本地缓存 | 走全量请求（8s） |
| `empty` | 空消息 + 非 MERGE + 无主线 + 无 completion + 无缓存 | 立即返回 `empty`，不发请求 |
| `unknown` | 两类证据都不足 | 走全量；超时按“无法确认”收尾 |

补充规则：标题会过滤占位词（新对话 / 未命名 / New chat 等），避免把新对话当成老对话。

### 2.4 判定时机

1. `hardRefreshHistory` 入口先判定一次，`empty` 直接收尾（省去增量探测）
2. 增量探测遇到 MERGE + 无缓存时，把 `MERGE` 记入事实，再走全量确认
3. 全量请求前再判定一次，仍为 `empty` 才截断

效果：

- 真新对话：页面自身那条空历史响应就足以形成负向证据，点刷新**零请求、秒回**
- 老对话清缓存：`MERGE` 或 `current_message_id` 任一条即判定为老对话，不会误报

---

## 三、历史数据正确性修复

### 3.1 文本估算收敛（防止小残片覆盖总量）

**问题**：增量响应只带本轮新增消息，若这些消息缺少 `accumulated_token_usage`，原逻辑会用文本估算得到一个很小的值（如 2324），随后经 `post-turn` 覆盖几十万的真实总量。

**修复**：

- 新增 `isFullResponse(source, cacheControl)`：只有 `page` / `hard-fetch` 且 `cache_control !== 'MERGE'` 的响应才允许估算
- 增量、落库校准、增量式手动复放一律不估算
- 估算值必须 `> 0` 且不低于已有 `postTotal`，违背则丢弃
- `state.postTotal` 仅在 `baseline != null` 时更新，无有效数据时不再清空既有总量

### 3.2 MERGE 空包不再判定为新对话

**问题**：带正确 `cache_version` 请求，服务端返回 `MERGE` 且 `chat_messages` 为空；本地恰好无缓存时被直接判定为“新对话无历史数据”。

**修复**：删除 `count === 0` 截断分支，记录 `historyCtrl = MERGE` 后继续走全量确认。真正的空对话仍由全量结果的 `messages.length === 0` 分支给出 `empty`。

### 3.3 历史请求三段式超时

**问题**：

- 空对话的服务端会挂起历史请求，固定墙钟超时能兜住
- 但老对话全量包可达 1.1MB，弱网下从建连到收完可能超过 8 秒，同一个固定值会误杀正常请求
- 前端已有 30 秒兜底，底层超时必须早于它给出明确结论

**修复**：`requestHistory` 改为三段式超时 + 流式读取：

| 阶段 | 判定 | 触发 |
|------|------|------|
| TTFB 超时 | 请求发出后迟迟拿不到响应头 | 服务端挂起 |
| 空闲超时 | 已开始收包，连续 N 秒没有新字节 | 连接卡死 |
| 总耗时上限 | 从发起到结束 | 兜底，始终小于前端 30s |

- 使用 `res.body.getReader()` + `TextDecoder` 逐块拼接文本，每收到一块重置空闲计时，慢但有进度的下载不会被误杀
- 所有定时器（TTFB / 空闲 / 总）在 `finally` 中统一清理
- 超时中止返回 `{ aborted: true, reason }`，不再走请求头复放

超时档位按会话事实选择：

| 判定 | TTFB | 空闲 | 总上限 |
|------|------|------|--------|
| `unknown` | 4s | 8s | 15s |
| `history`（≤ 50 条） | 6s | 10s | 20s |
| `history`（> 50 条） | 8s | 15s | 25s |

自动落库校准同步改为：增量 4/8/15s，无模板全量 5/12/20s。

### 3.4 事实不足宽限期

`unknown` 只出现在“页面自身的历史请求尚未返回”时。此时若页面请求正在进行（`passiveInFlight > 0`），先等待 1.2 秒：

- 期间被动响应返回并形成事实 → 重新 `classifyHistory`，可确认 `empty` 或直接复用数据
- 宽限期结束仍 `unknown` → 按短档发起全量

### 3.5 主动 / 被动请求收敛

- 被动历史请求记录 `passiveInFlight`；成功应用（`applyHistory` 返回 ok）时写入 `passiveResolvedAt`
- 若此时主动全量仍在进行，标记 `superseded` 并 abort 主动请求，避免重复下载 1MB 大包
- 主动请求无论因超时、异常还是被取消返回，只要 `superseded` 已置位，一律不向 UI 回传 `timeout` / `failed`

### 3.6 请求防重入

**问题**：`requestHardRefresh` 没有在入口拦截正在进行的请求，连点会重置 30 秒超时并重复发起。

**修复**：首行增加 `pendingHardRefresh` 守卫，提示「正在同步历史，请稍候…」后直接返回。

### 3.7 首轮 `roundTokens` 的新老对话判定

**问题**：内存里没有上一轮总量（`postTotal = null`）时，原逻辑一律把本轮记为 `null`：

- 真新对话第一轮显示「本轮 —」，看不到首条消息的消耗
- 若简单用 `roundTokens = total` 兜底，老对话重载后的首轮会把几十万历史总量当成本轮消耗

**修复**：新增 `looksLikeNewConversation(state)`，依据会话事实判定：

```
无 current_message_id
且 无有效标题（过滤“新对话/未命名”等占位词）
且 cache_control 不为 MERGE
且 historyCount ≤ 4
```

判定分支：

| 条件 | roundTokens |
|------|-------------|
| `before != null && total > before` | `total − before`（常规轮次） |
| `before == null` 且判定为新对话 | `total`（第一轮） |
| `before == null` 且判定为老对话 | `null`（保持「本轮 —」，绝不用历史总量兜底） |

带模板（增量响应只包含本轮新增消息）时使用**请求前**采集的事实，避免增量包消息数偏小被误判为新对话；无模板（走全量）时使用请求后的消息总数。

---

## 四、状态与日志

### 4.1 新增 `timeout` 状态

`sync-status` 现在有三种收尾：

| 状态 | 含义 | 前端提示 |
|------|------|----------|
| `empty` | 确认无历史 / 新对话 | 该会话暂无历史数据 |
| `failed` | 请求失败且复放失败 | 历史拉取失败，已保留缓存 |
| `timeout` | 8 秒内无法确认 | 无法确认历史，请稍后重试 |

三者都会停止转圈并清除 `pendingHardRefresh`，不再干等 30 秒。

### 4.2 日志降噪

- fetch / XHR 的调试日志只匹配 `COMPLETION_PATH` 与 `HISTORY_PATH`，不再打印全部 `/api/` 请求
- 落库校准失败由 `console.warn` 降为 `console.log`（属于预期内失败）

---

## 五、SSE 补丁结构与自动重连

### 5.1 补丁结构解析

抓包确认累计值可能不是直接字段，而是路径式补丁：

```
data: {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":234654}]}
```

原实现只按 key 查找，`findFirst(json, 'accumulated_token_usage')` 与 `rawTail` 正则都无法命中。本版新增：

- `findPatchValue(node, path)`：递归识别 `{p, v}` 对象，同一帧内多个同名字段保留最后一个
- `findField(node, key)`：先按 key 查找，再按补丁查找，两种格式统一出口
- `update_file` 的 `token_usage` / `is_image` / `file_id` 同样走 `findField`，避免附件用量漏采
- `rawTail` 兜底新增补丁正则 `"p":"accumulated_token_usage","v":数字`，并按出现位置取最后一条

### 5.2 同轮重连去重

官方 `sse_auto_resume_timeout = 3000` 意味着断线后会自动 `resume_stream`，一轮生成可能跨多个 SSE 连接：

- 每个连接结束都会 `reportEnd`，原逻辑会各自触发一次落库校准
- 本版在会话级记录 `lastSyncAt`，1.2 秒内只允许触发一次 `syncAfterTurn`，其余记录「跳过重复落库校准（同轮重连）」
- 重复上报的相同 usage 值不再重复推送给 UI，但仍会标记本轮已拿到真值

### 5.3 中断不参与契约告警

- fetch SSE 在 `parseStream` 捕获到中断时调用 `parser.abort()`
- XHR completion 监听 `error` / `abort` 事件，同样标记中断
- `reportEnd` 对中断连接不再累加 `missCount`，避免网络抖动或用户停止生成被误判为「站点改版」

---

## 六、变更文件

| 文件 | 改动 |
|------|------|
| `inject.js` | 会话事实字段与 `classifyHistory`、估算收敛、MERGE 空包处理、8s 超时与 `timeout` 状态、`hasCompletion` 标记、补丁结构解析、重连去重与中断标记、日志降噪 |
| `content.js` | `requestHardRefresh` 防重入、`sync-status` 兼容 `timeout` |
| `manifest.json` | 版本 1.3.2 |
| `DeepBrim-V1.3.2-功能文档.md` | 本文档 |

---

## 七、验证清单

- [x] 真新对话（页面历史为空、`cache_control` 非 MERGE）点刷新 → **新增请求 0 次**，立即提示「该会话暂无历史数据」
- [x] 老对话 + 本地缓存已清（增量返回 MERGE 空、带 `current_message_id`）→ 自动转全量，基线正确，不误报空对话
- [x] 新对话第一轮（页面历史为空）→ `roundTokens = total`，「本轮」不再显示 `—`
- [x] 同一会话第二轮 → `roundTokens = total − prev`（实测 150 − 91 = 59）
- [x] 老对话重载首轮（`postTotal = null`、MERGE 空、有 `current_message_id`）→ `roundTokens = null`，不会把 30 万总量算成本轮
- [x] 增量响应缺字段时不再出现 `2324` 这类小估算覆盖总量
- [x] 补丁帧 `{"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":234654}]}` 能解析出 234654
- [x] 同一轮两个连接重复上报同一 usage → 落库校准只触发 1 次
- [x] 中断（`abort`）连接即使有 JSON 帧也不会累计契约告警
- [x] 历史请求挂起 → TTFB 4 秒中止，回传 `timeout`，不再等前端 30 秒
- [x] 大包慢下载但持续有进度 → 空闲计时不断重置，正常完成，不误报超时
- [x] 页面自身历史先返回 → 主动全量被 abort，标记 `superseded`，不回传 `failed` / `timeout`
- [x] 事实不足且页面请求进行中 → 1.2 秒宽限期内可确认 `empty`，不发起全量
- [x] 转圈期间重复点击「重新拉取历史」不会重复发起请求
- [x] 控制台不再打印无关的 `/api/` 请求日志
- [x] `inject.js`、`content.js` 通过 `node --check`

---

## 八、已知限制与待办

1. 会话事实仅存在于内存，页面刷新后需重新从页面历史响应中采集
2. 官方 `normal_history_and_file_token_limit = 890880` 已确认只代表“输入+附件”额度，**不参与百分比分母**（分母固定 1M），本版未接入该参考线
3. 补丁结构解析覆盖 `p/v` 单层与嵌套数组；若站点改为其他补丁操作符（如带索引路径的 `SET/APPEND` 组合），仍需按实际报文补充
4. 同轮重连去重依赖 1.2 秒时间窗；若两个真实轮次在 1.2 秒内接连结束（几乎不可能），可能少一次校准
5. 超时档位依赖 `historyCount` 估算包体大小；若会话被大幅删除导致计数与真实体积不符，仍以总上限兜底
6. 请求头复放（`refreshHistory`）仍为原有实现，未接入三段式超时
7. 仍未提供扩展图标资源
