# DeepBrim V1.3.3 功能文档

> 版本：v1.3.3（manifest 同步）
> 平台：Microsoft Edge · Manifest V3
> 文档范围：仅记录 **v1.3.2 之后** 的增量改动
> 文档日期：2026-11-07

---

## 一、版本概览

v1.3.3 包含两类改动，均为稳定性与体验向，不新增统计口径：

1. **历史请求超时重构**：固定 8 秒墙钟 → 三段式超时 + 事实驱动档位 + 被动请求收敛
2. **开发者调试模式**：底层日志默认静默，由设置页开关动态控制；调试入口随开关挂载/卸载

> 说明：v1.3.2 文档在开发过程中曾就地追加过超时相关章节，本文件为这些内容的最终归属版本。

---

## 二、历史请求三段式超时

### 2.1 问题

| 场景 | 固定 8 秒墙钟的结果 |
|------|---------------------|
| 空白新对话，服务端对历史请求不响应 | 需要完整等待 8 秒 |
| 老对话全量包约 1.1MB，弱网慢下载 | 下载尚未完成就被误杀 |
| 前端已有 30 秒兜底 | 底层先报失败，提示含义不准确 |

一个固定值同时承担“判断服务端是否挂起”和“限制下载总时长”，两种语义冲突。

### 2.2 三段式判定

| 阶段 | 判定 | 触发后的含义 |
|------|------|--------------|
| TTFB 超时 | 请求发出后迟迟拿不到响应头 | 服务端挂起（空对话典型） |
| 空闲超时 | 已开始收包，但连续 N 秒没有新字节 | 连接卡死 |
| 总耗时上限 | 从发起到结束 | 兜底，始终小于前端 30s |

实现要点：

- `AbortController` + 三个定时器，全部在 `finally` 中清理
- 使用 `res.body.getReader()` 读取，`TextDecoder` 逐块拼接文本
- **每收到一块就重置空闲计时**，慢但持续有进度的下载不会被误杀
- 中止返回 `{ aborted: true, reason }`，`reason` 区分 `header` / `idle` / `total`，不再走请求头复放

### 2.3 事实驱动档位

| 判定 | TTFB | 空闲 | 总上限 |
|------|------|------|--------|
| `unknown` | 4s | 8s | 15s |
| `history`（≤ 50 条消息） | 6s | 10s | 20s |
| `history`（> 50 条消息） | 8s | 15s | 25s |

自动落库校准同步调整：

- 增量：`4s / 8s / 15s`
- 无模板全量：`5s / 12s / 20s`

---

## 三、事实不足宽限期

`unknown` 只会出现在“页面自身的历史请求尚未返回”这一种情况。此时：

1. 若检测到页面请求进行中（`passiveInFlight > 0`），先等待 1.2 秒
2. 期间被动响应返回并更新会话事实 → 重新分类，可确认 `empty` 或直接复用数据，**不再发全量**
3. 宽限期结束仍 `unknown` → 按短档发起全量

收益：用户手快点击时不再必然吃一次完整超时，也避免与页面请求重复下载大包。

---

## 四、主动 / 被动请求收敛

- 每个会话记录 `passiveInFlight`、`passiveResolvedAt`、`activeHistory`
- 被动历史响应成功应用（`applyHistory` 返回 ok）时：
  - 标记 `superseded`
  - 若主动全量仍在进行，立即 abort 主动请求
- 主动请求返回时，只要 `superseded` 已置位：
  - 不应用数据、不回传 `timeout` / `failed`
  - 只记录一条「页面自身历史已先行完成，放弃主动拉取」

这样前端转圈由被动数据正常解除，后台不会残留一条无效的大包请求。

---

## 五、开发者调试模式

### 5.1 默认静默

- `inject.js`：`let DEBUG = false`（`DEBUG_DEFAULT = false`），启动时不输出任何日志
- `content.js`：`debugMode` 默认 false，浮层自身日志同样静默
- 全文不再有 `console.log` / `console.warn` 直接调用，统一走两个出口：

| 出口 | 位置 | 行为 |
|------|------|------|
| `dbg(...)` | `inject.js` | `DEBUG` 为真时输出 `[DeepBrim]` 日志 |
| `cdbg(...)` | `content.js` | `debugMode` 为真时输出 |

### 5.2 设置界面

- 位置：设置 → 基础 → 自动清除缓存下方
- 控件：`#db-debug-toggle` 复选框，文案「开启底层调试日志 (DEBUG)」
- 状态持久化：`chrome.storage.local` 的 `deepbrim.debugMode`（默认 false）
- 勾选/取消：写入存储 → 通过 `postMessage` 发送 `toggle-debug`

### 5.3 跨世界通信与初始化时序

```
inject.js 加载
  └─ postMessage({ source: 'deepbrim', type: 'debug-state-request' })

content.js
  ├─ bindEvents() 注册消息监听
  ├─ storage.get('deepbrim.debugMode') → 同步复选框 → 发送 toggle-debug
  └─ 收到 debug-state-request → 回发当前状态
```

两条路径互为兜底：任一方向先到达都能完成同步；都错过时默认 false 仍是安全态，用户再次切换即可。

### 5.4 底层响应

`toggle-debug` 到达时：

- `DEBUG = !!enabled`
- 开启：`installDebugApi()` 挂载脱敏后的 `window.__deepbrim`，并仅在状态真正切换时输出一次「🛠️ 开发者调试模式已开启」
- 关闭：`uninstallDebugApi()` 删除 `window.__deepbrim`

`__deepbrim.state(id)` 只返回 `{ latest, postTotal, fileCount }`，无参时返回 `{ sessionCount }`，不暴露会话 ID 映射与附件明细。

### 5.5 多标签页同步

`chrome.storage.onChanged` 监听 `deepbrim.debugMode`：

- 复选框勾选状态同步
- 重新发送 `toggle-debug`，让当前标签页的底层日志状态跟随

---

## 六、变更文件

| 文件 | 改动 |
|------|------|
| `inject.js` | 三段式超时 `requestHistory`、事实驱动档位、宽限期、`superseded` 收敛、被动请求计数、`DEBUG` 动态开关、`dbg()` 收敛日志、调试入口动态挂载 |
| `content.js` | 调试复选框 UI 与存储、`postDebugMode()` / `syncDebugToggle()`、`debug-state-request` 应答、`onChanged` 同步、`cdbg()` 收敛日志 |
| `manifest.json` | 版本 1.3.3 |
| `DeepBrim-V1.3.3-功能文档.md` | 本文档 |

---

## 七、验证清单

- [x] 历史请求被服务端挂起 → TTFB 阶段中止，回传 `timeout`
- [x] 大包分段慢速返回（每段间隔小于空闲阈值）→ 正常完成，不误报超时
- [x] 页面自身历史先返回 → 主动全量被 abort，不回传 `failed` / `timeout`
- [x] 事实不足且页面请求进行中 → 1.2 秒宽限期内确认结论，不发起全量
- [x] 默认安装后控制台无任何 `[DeepBrim]` 输出，`window.__deepbrim` 不存在
- [x] 勾选调试开关 → 出现「🛠️ 开发者调试模式已开启」，`window.__deepbrim` 可用
- [x] 取消勾选 → 日志立即静默，`window.__deepbrim` 被移除
- [x] 刷新页面后开关状态从存储恢复，初始化阶段的重复消息不会重复打印提示
- [x] 两个标签页切换开关 → 复选框与底层日志状态一致
- [x] `inject.js`、`content.js` 通过 `node --check`，manifest JSON 解析通过

---

## 八、已知限制

1. 超时档位依赖 `historyCount` 估算包体大小；会话被大幅删除导致计数与真实体积不符时，仍以总上限兜底
2. 请求头复放（`refreshHistory`）仍为原有实现，未接入三段式超时
3. 页面脚本同样可以伪造 `source: 'deepbrim-ui'` 的 `toggle-debug` 消息；影响仅限开启日志与暴露脱敏调试入口，不涉及数据上报
4. 调试状态按页面加载初始化一次，切换开关即时生效但不跨浏览器重启保留底层内部状态（存储本身已持久化）
5. 仍未提供扩展图标资源
