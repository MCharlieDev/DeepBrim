# DeepBrim V1.3.1 功能文档

> 版本：v1.3.1（manifest 同步）
> 平台：Microsoft Edge · Manifest V3
> 文档范围：仅记录 **v1.3.0 之后** 的增量改动
> 文档日期：2026-11-05

---

## 一、版本概览

v1.3.1 是**健壮性修复**，不新增界面与设置，集中处理三件事：

1. 历史回补与鉴权捕获从“仅 XHR”扩展为“XHR + fetch 双路径”
2. 主动拉取历史两条兜底路径都失败时，前端不再空转到 30 秒超时
3. 调试入口 `window.__deepbrim` 加门控并脱敏

数据口径（总量 / 本轮 / 附件）与 v1.3.0 完全一致，未改动。

---

## 二、fetch 与 XHR 对等捕获

### 2.1 问题

历史回补模板 `lastHistoryRequest` 与 `lastAuthHeader` 只在 XHR 通道被记录。若站点把 `history_messages` 或 `completion` 迁到 `fetch`：

- `lastHistoryRequest` 永远为 `null`，`refreshHistory` 直接失效
- 增量模板无法沉淀，每轮都退回全量
- 鉴权只能靠 `localStorage` 兜底，稳定性下降

### 2.2 fetch 侧新增能力

| 能力 | 实现 |
|------|------|
| 请求头记录 | `captureRequestHeaders()` 把 `init.headers` / `Request.headers` 统一转为可复放字典 |
| 鉴权记录 | `rememberAuthHeader()` 写入 `lastAuthHeader`（大小写不敏感） |
| 历史响应捕获 | `captureHistoryResponse()` 读取 `response.clone().text()`，填充 `lastHistoryRequest` 并复用 `applyHistory(..., 'page')` |

completion 与 history 两条 fetch 路径都会记录请求头；clone 读取不阻塞页面自身的响应消费。

### 2.3 模板 URL 动态推导

- `requestHistory()` 现在返回 `{ text, json, count, url, headers }`，`url` 取 `res.url`（真实最终地址）
- `syncAfterTurn` 沉淀模板时调用 `buildIncrementalUrl(baseUrl, ...)`，在真实路径上替换 `chat_session_id` / `cache_version` / `cache_reset_at`，并移除 `_t`
- 不再硬编码 `/api/v0/chat/history_messages`，API 版本变化后仍能跟随实际请求路径

### 2.4 兜底路径补前缀

- 匹配用 `HISTORY_PATH` 保持宽松（任一版本路径都命中）
- 新增 `HISTORY_FALLBACK_PATH = /api/v0/chat/history_messages`，仅用于“连模板都没有”时发请求
- `buildHistoryUrl()`、`probeLimit()` 的兜底从缺前缀的 `/chat/history_messages` 改为带前缀路径

---

## 三、主动拉取失败即时收尾

### 3.1 问题

`hardRefreshHistory` 的全量请求失败、数据无效回退、异常回退三条路径，原先只 `await refreshHistory()` 就返回。当复放也失败（或无模板）时：

- 不发送任何 `sync-status`
- `content.js` 的 `pendingHardRefresh` 只能干等 30 秒兜底定时器
- 用户看到的是持续转圈 30 秒

### 3.2 修复

三条路径在 `refreshHistory()` 返回 `null` 时统一调用：

```js
reportRefreshFailed(target) // postToContent('sync-status', { sessionId, status: 'failed' })
```

前端新增 `failed` 分支：立即清除 `pendingHardRefresh`、清定时器、停止转圈，提示「历史拉取失败，已保留缓存」。

与超时提示「请求超时，已保留缓存」文案区分，便于判断是请求失败还是响应过慢。

---

## 四、调试入口收敛

`window.__deepbrim` 调整（`inject.js` 末尾）：

| 项目 | 调整前 | 调整后 |
|------|--------|--------|
| 挂载条件 | 无条件 | `if (DEBUG)` 门控 |
| `state(id)` | 返回完整 session（含 files 明细） | 只返回 `{ latest, postTotal, fileCount }` |
| `state()` | 返回整个 sessions Map（含全部会话 ID） | 只返回 `{ sessionCount }` |

`refreshHistory` / `probeLimit` 调试方法保留在 `DEBUG` 下，便于排查。

---

## 五、变更文件

| 文件 | 改动 |
|------|------|
| `inject.js` | fetch 历史捕获与请求头记录、模板 URL 动态推导、`HISTORY_FALLBACK_PATH`、`reportRefreshFailed`、`__deepbrim` 门控与脱敏 |
| `content.js` | `sync-status` 新增 `failed` 分支 |
| `manifest.json` | 版本 1.3.1 |
| `DeepBrim-V1.3.1-功能文档.md` | 本文档 |

---

## 六、验证清单

- [x] `fetch('/api/v0/chat/history_messages?chat_session_id=...')` 后控制台出现 `🗂 捕获到 history_messages 响应（fetch）`
- [x] 上述请求后 `lastHistoryRequest` 被填充，`refreshHistory` 可复用其 URL
- [x] 断网点「重新拉取历史」→ 数秒内提示「历史拉取失败，已保留缓存」，不再等 30 秒
- [x] 正常路径下仍出现 `via=incremental` / `via=full` 的落库校准日志，语义不变
- [x] 模板沉淀日志中的 URL 路径与真实请求一致（不再固定 `/api/v0` 字符串拼接）
- [x] 控制台 `__deepbrim.state()` 只返回 `{ sessionCount }`，不泄露会话 ID 列表
- [x] `content.js`、`inject.js` 通过 `node --check`，manifest JSON 解析通过

---

## 七、已知限制

1. 当前站点历史接口仍走 XHR，fetch 分支属对冲能力，只有在站点迁移或手动触发时才走
2. fetch 历史捕获需要读取一份 clone 响应体，超大历史（约 1.4MB）会带来一次额外的文本解析，与 XHR 路径成本相当
3. `DEBUG` 目前为 `true`，脱敏后的调试入口仍对页面脚本可见；发布前可把 `DEBUG` 置 `false` 彻底关闭
4. D（会话 Map 近似 LRU）、E（localStorage token 白名单放宽）按约定挂起
