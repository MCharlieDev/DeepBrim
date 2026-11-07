// DeepBrim - 核心脚本（MAIN world）
// 阶段 2：fetch + XHR 拦截、SSE 真值解析、历史回补（history_messages 基线估算）

const TAG = '[DeepBrim]'
const COMPLETION_PATH = '/chat/completion'
const HISTORY_PATH = '/chat/history_messages'
// 连请求模板都还没捕获到时的最后兜底路径（匹配用 HISTORY_PATH，发请求用这个）
const HISTORY_FALLBACK_PATH = '/api/v0/chat/history_messages'
const DEBUG_DEFAULT = false
// 由设置页通过 postMessage 动态控制，默认静默
let DEBUG = DEBUG_DEFAULT
const RAW_TAIL_LIMIT = 64 * 1024

// 历史消息里可能承载正文的字段，估计时只走这些 key，避免把 id / 时间戳算进去
const CONTENT_KEYS = new Set([
  'content',
  'thinking_content',
  'reasoning_content',
  'text',
  'fragments',
  'prompt',
  'title',
  'message'
])

const sessions = new Map()
let lastHistoryRequest = null
let currentSessionId = null
let lastAuthHeader = null
let contractWarned = false

const MAX_SESSIONS = 200
const MAX_FILES = 200

// 底层正常路径日志统一出口：默认关闭，只有调试开关打开时才输出
function dbg(...args) {
  if (DEBUG) console.log(TAG, ...args)
}

function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    // 上限保护：会话状态只增不减会在长时间 SPA 使用中累积
    if (sessions.size >= MAX_SESSIONS) {
      const oldest = sessions.keys().next().value
      if (oldest !== sessionId) sessions.delete(oldest)
    }
    sessions.set(sessionId, {
      latest: null,
      turnHasUsage: false,
      missCount: 0,
      postTotal: null,
      files: [],
      // 会话事实：用于区分“清过缓存的老对话”和“真正的新对话”
      hasCompletion: false,
      historyCount: null,
      historyCtrl: null,
      currentMessageId: null,
      historyTitle: null,
      // 同轮重连去重：记录最近一次触发落库校准的时间
      lastSyncAt: 0,
      // 页面自身的被动历史请求：用于宽限期等待与主动请求收敛
      passiveInFlight: 0,
      passiveResolvedAt: 0,
      activeHistory: null,
      superseded: false
    })
  }
  return sessions.get(sessionId)
}

/* ---------------- SSE 解析器（fetch / XHR 共用） ---------------- */

function createSseParser(sessionId) {
  const state = getSession(sessionId)
  // 保留上一轮的值：本轮还没拿到新值前，界面继续显示旧值
  state.turnHasUsage = false
  state.turnHasFrame = false
  let buffer = ''
  let rawTail = ''
  let aborted = false

  return {
    push(text) {
      if (!text) return
      rawTail = (rawTail + text).slice(-RAW_TAIL_LIMIT)
      // 兼容 CRLF / 单独 CR 的 SSE 帧分隔，避免整段拼成非法 JSON
      buffer = (buffer + text).replace(/\r\n?/g, '\n')

      let splitIndex = buffer.indexOf('\n\n')
      while (splitIndex !== -1) {
        const frame = buffer.slice(0, splitIndex)
        buffer = buffer.slice(splitIndex + 2)
        handleFrame(frame, sessionId, state)
        splitIndex = buffer.indexOf('\n\n')
      }
    },
    // 断线中断：区分“网络抖动”与“站点改版”，中断不参与契约告警计数
    abort() {
      aborted = true
    },
    flush() {
      if (buffer.trim()) {
        handleFrame(buffer, sessionId, state)
        buffer = ''
      }
      // 兜底：整段响应不是标准 SSE 时，直接从原文里抓最后一个数字
      if (!state.turnHasUsage) {
        const last = lastUsageFromRaw(rawTail)
        if (last !== null) {
          state.latest = last
          state.turnHasUsage = true
          dbg('📊 兜底抓到 accumulated_token_usage =', last)
        }
      }
      reportEnd(sessionId, state, aborted)
    }
  }
}

// 原文兜底同时兼容两种下发格式：直接字段与 {p,v} 补丁
function lastUsageFromRaw(rawTail) {
  const hits = []
  for (const match of rawTail.matchAll(/"accumulated_token_usage"\s*:\s*(\d+)/g)) {
    hits.push({ index: match.index || 0, value: Number(match[1]) })
  }
  for (const match of rawTail.matchAll(
    /"p"\s*:\s*"accumulated_token_usage"\s*,\s*"v"\s*:\s*(\d+)/g
  )) {
    hits.push({ index: match.index || 0, value: Number(match[1]) })
  }
  if (!hits.length) return null
  hits.sort((a, b) => a.index - b.index)
  return hits[hits.length - 1].value
}

function handleFrame(frame, sessionId, state) {
  let event = ''
  const dataLines = []

  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim())
    }
  }

  if (!dataLines.length) return

  const json = safeParse(dataLines.join('\n'))
  if (!json) return
  state.turnHasFrame = true

  // 附件：官方直接给 token_usage
  if (event === 'update_file') {
    const tokens = findField(json, 'token_usage')
    if (typeof tokens === 'number') {
      const isImage = findField(json, 'is_image') === true
      // 同一文件可能先来估算帧、再来精确帧：按 file_id 去重并取最新值
      const fileId =
        [findField(json, 'file_id'), findField(json, 'filename'), findField(json, 'name')]
          .find((value) => typeof value === 'string' && value) || null

      const existing = fileId ? state.files.find((file) => file.id === fileId) : null
      if (existing) {
        existing.tokens = tokens
      } else {
        state.files.push({ id: fileId, tokens, isImage })
        if (state.files.length > MAX_FILES) {
          state.files.splice(0, state.files.length - MAX_FILES)
        }
      }

      const total = state.files.reduce((sum, file) => sum + (file.tokens || 0), 0)
      dbg('📎 附件用量', { tokens, isImage, total })
      postToContent('file-usage', { sessionId, tokens, isImage, total })
    }
    return
  }

  // 主路径：累计用量。兼容直接字段与 {p,v} 补丁两种结构
  const usage = findField(json, 'accumulated_token_usage')
  // 0 是首轮早期的占位值，不作为有效统计
  if (typeof usage === 'number' && usage > 0) {
    // 自动重连时可能重复下发同一个值：仍标记本轮有真值，但不重复推送
    state.turnHasUsage = true
    if (state.latest !== usage) {
      state.latest = usage
      dbg('📊 accumulated_token_usage =', usage)
      postToContent('usage', {
        sessionId,
        total: usage
      })
    }
  }
}

function reportEnd(sessionId, state, aborted) {
  dbg('🎉 数据流读取完毕', {
    sessionId,
    promptTotal: state.latest,
    postTotal: state.postTotal,
    attachments: state.files,
    aborted: !!aborted
  })

  postToContent('stream-end', {
    sessionId,
    total: state.latest,
    attachmentTokens: state.files.reduce((sum, f) => sum + (f.tokens || 0), 0)
  })

  if (state.turnHasUsage) {
    state.missCount = 0
    // 自动重连可能让同一轮产生多个 SSE 连接：短时间内只校准一次
    const now = Date.now()
    if (now - (state.lastSyncAt || 0) > 1200) {
      state.lastSyncAt = now
      setTimeout(() => syncAfterTurn(sessionId), 600)
    } else {
      dbg('🗂 跳过重复落库校准（同轮重连）')
    }
  } else if (state.turnHasFrame && !aborted) {
    // 契约探针：连续多轮有正常帧却解析不到字段，基本可以判定站点改版
    state.missCount = (state.missCount || 0) + 1
    dbg(`⚠️ 本轮未解析到 accumulated_token_usage（连续 ${state.missCount} 轮）`)
    if (state.missCount >= 3 && !contractWarned) {
      contractWarned = true
      postToContent('contract-warning', { sessionId })
    }
  }
}

// 生成结束后静默校准：拿到落库后的真实总量（含本轮回复）
async function syncAfterTurn(sessionId) {
  const state = getSession(sessionId)
  const before = state.postTotal
  // 请求前先记下“是否像新对话”，避免增量响应只带本轮消息把判断带偏
  const newBeforeTurn = looksLikeNewConversation(state)
  const hasTemplate =
    !!lastHistoryRequest &&
    !!lastHistoryRequest.url &&
    getSessionIdFromUrl(lastHistoryRequest.url) === sessionId

  // 新对话没有可复用的历史请求模板，改用一次全量请求（此时消息很少，成本低）
  const url = hasTemplate ? replaceParam(lastHistoryRequest.url, 'chat_session_id', sessionId) : buildHistoryUrl(sessionId)

  // 增量与全量使用不同的三段式超时档位
  const incrementalTimeouts = { headerTimeout: 4000, idleTimeout: 8000, totalTimeout: 15000 }
  const fullTimeouts = { headerTimeout: 5000, idleTimeout: 12000, totalTimeout: 20000 }

  let result = await requestHistory(url, hasTemplate ? incrementalTimeouts : fullTimeouts)
  // 新对话可能尚未落库，或增量暂时为空：退避 1.2 秒再试一次全量
  const emptyResult = (res) => !res || res.aborted || res.count <= 0
  if (!hasTemplate && emptyResult(result)) {
    dbg('🗂 落库校准：首轮为空，1.2s 后重试')
    await new Promise((resolve) => setTimeout(resolve, 1200))
    result = await requestHistory(url, fullTimeouts)
  }
  if (!result || result.aborted) {
    // 预期内的失败，不升级成 warn，避免控制台/扩展错误面板产生噪音
    dbg('🗂 落库校准失败（不影响主流程）')
    return
  }
  if (result.count <= 0) {
    dbg('🗂 落库校准：没有新消息，跳过')
    return
  }

  const ok = applyHistory(sessionId, result.text, 'after-turn')
  if (!ok) return

  // 全量请求没有版本号，若响应里带回版本信息，就把它沉淀成后续增量模板
  if (!hasTemplate && result.json) {
    const cacheVersion = findFirst(result.json, 'cache_version')
    if (cacheVersion != null) {
      // 路径从真实响应 URL 推导，兼容 API 版本变化
      const baseUrl = result.url || url
      lastHistoryRequest = {
        url: buildIncrementalUrl(baseUrl, sessionId, cacheVersion, findFirst(result.json, 'cache_reset_at')),
        headers: result.headers || {}
      }
      dbg(`🗂 已沉淀增量模板 cache_version=${cacheVersion}`)
    }
  }

  const total = state.postTotal
  // 请求后的消息数：无模板走全量，此时可以直接用它判断是否为新对话
  const newAfterTurn = looksLikeNewConversation(state)

  let roundTokens = null
  if (before != null && total != null && total > before) {
    // 常规轮次：落库总量向前增长，差值即本轮
    roundTokens = total - before
  } else if (before == null && total != null && total > 0) {
    // 首轮（内存里没有上一轮总量）：只有确认是新对话才把总量当本轮，
    // 否则老对话重载后的首轮会把几十万历史总量算成本轮消耗
    const newConversation = hasTemplate ? newBeforeTurn : newAfterTurn
    if (newConversation) {
      roundTokens = total
    } else {
      dbg('🗂 首轮疑似历史对话，本轮消耗保持未知')
    }
  }

  dbg(
    `🗂 落库校准 total=${total} prev=${before} round=${roundTokens} via=${
      hasTemplate ? 'incremental' : 'full'
    } newConv=${hasTemplate ? newBeforeTurn : newAfterTurn}`
  )

  postToContent('post-turn', {
    sessionId,
    total,
    roundTokens,
    roundSource: roundTokens != null ? 'post-turn' : 'unknown'
  })
}

// 历史请求三段式超时：等响应头（TTFB）、收包空闲、总耗时上限
// 固定墙钟无法同时覆盖“服务端挂起”和“大包弱网慢下载”，必须分阶段判定
function requestHistory(url, options = {}) {
  const opts =
    typeof options === 'number'
      ? { headerTimeout: options, idleTimeout: options, totalTimeout: options }
      : options

  const headerTimeout = opts.headerTimeout != null ? opts.headerTimeout : 6000
  const idleTimeout = opts.idleTimeout != null ? opts.idleTimeout : 10000
  const totalTimeout = opts.totalTimeout != null ? opts.totalTimeout : 20000
  const controller =
    opts.controller || (typeof AbortController !== 'undefined' ? new AbortController() : null)

  let headerTimer = null
  let idleTimer = null
  let totalTimer = null
  let abortReason = null

  const clearTimers = () => {
    clearTimeout(headerTimer)
    clearTimeout(idleTimer)
    clearTimeout(totalTimer)
    headerTimer = null
    idleTimer = null
    totalTimer = null
  }

  const abortWith = (reason) => {
    if (abortReason) return
    abortReason = reason
    try {
      if (controller) controller.abort()
    } catch {
      // 已结束
    }
  }

  const armIdle = () => {
    clearTimeout(idleTimer)
    if (controller) idleTimer = setTimeout(() => abortWith('idle'), idleTimeout)
  }

  return (async () => {
    try {
      const headers = buildAuthHeaders()

      if (controller) {
        headerTimer = setTimeout(() => abortWith('header'), headerTimeout)
        totalTimer = setTimeout(() => abortWith('total'), totalTimeout)
      }

      const res = await origFetch(url, {
        method: 'GET',
        headers,
        credentials: 'include',
        signal: controller ? controller.signal : undefined
      })

      // 响应头已到达：结束 TTFB 阶段，进入收包阶段
      clearTimeout(headerTimer)
      headerTimer = null
      if (!res.ok) {
        clearTimers()
        return null
      }

      let text = ''
      if (res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader()
        const decoder = new TextDecoder('utf-8')
        armIdle()

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          // 每收到一块就重置空闲计时，慢但持续的下载不会被误杀
          armIdle()
          text += decoder.decode(value, { stream: true })
        }
        text += decoder.decode()
      } else {
        text = await res.text()
      }

      clearTimers()
      const json = safeParse(text)
      const count = json ? (findMessageArray(json).arr || []).length : 0
      return {
        text,
        json,
        count,
        url: res.url || url,
        headers,
        status: res.status,
        contentType: res.headers.get('content-type') || '',
        aborted: false
      }
    } catch {
      if (abortReason) {
        dbg(`🗂 历史请求中止（${abortReason}）`)
        return { aborted: true, reason: abortReason }
      }
      return null
    } finally {
      clearTimers()
    }
  })()
}

/* ---------------- 历史回补 ---------------- */

// 只有全量响应（非 MERGE 增量）才适合做文本估算
function isFullResponse(source, cacheControl) {
  if (cacheControl === 'MERGE') return false
  return source === 'page' || source === 'hard-fetch'
}

function applyHistory(sessionId, text, source) {
  if (!sessionId || sessionId === 'unknown') {
    dbg('🗂 历史响应缺少有效会话 ID，已丢弃')
    return false
  }

  const json = safeParse(text)
  if (!json) {
    dbg('🗂 历史响应不是 JSON，无法回补')
    return
  }

  const { arr: messages } = findMessageArray(json)
  const cacheControl = findFirst(json, 'cache_control')
  const state = getSession(sessionId)

  // 会话可能有多条分支消息，只有 current_message_id 指向的才是当前主线
  const currentMessageId = findFirst(json, 'current_message_id')
  let baseline = null
  let baselineSource = 'unknown'

  if (messages && messages.length) {
    if (currentMessageId != null) {
      const current = messages.find((msg) => msg && msg.message_id === currentMessageId)
      const value = current && current.accumulated_token_usage
      if (typeof value === 'number') baseline = value
    }

    // 兜底：找不到主线消息时，再取所有消息里的最大值
    if (baseline == null) {
      for (const msg of messages) {
        if (!msg || typeof msg !== 'object') continue
        const value = msg.accumulated_token_usage
        if (typeof value === 'number' && (baseline == null || value > baseline)) {
          baseline = value
        }
      }
    }

    if (baseline != null) {
      baselineSource = 'message-field'
    } else if (isFullResponse(source, cacheControl)) {
      // 只有全量响应才允许文本估算：增量包数据不全，估出来必然是错的
      const estimated = messages.reduce((sum, msg) => sum + estimateTokens(extractText(msg)), 0)
      // 估算值不得低于已有总量，避免小残片覆盖真实值
      const monotonic = state.postTotal == null || estimated >= state.postTotal
      if (estimated > 0 && monotonic) {
        baseline = estimated
        baselineSource = 'estimate'
      }
    }
  }

  // 0 不是有效基线：新对话或消息尚未落库时，宁可不显示也不显示 0
  if (typeof baseline === 'number' && baseline <= 0) {
    baseline = null
    baselineSource = 'unknown'
  }

  currentSessionId = sessionId
  // baseline 为 null 时不动已有总量，避免无有效数据时把总量清空
  if (baseline != null) state.postTotal = baseline
  if (baseline != null && state.latest === null) state.latest = baseline

  const ok = baseline != null || (messages && messages.length > 0)
  const title = findFirst(json, 'title')

  // 记录会话事实，供后续判断“老对话”还是“新对话”，避免再次误判
  state.historyCount = messages ? messages.length : 0
  state.historyCtrl = typeof cacheControl === 'string' ? cacheControl : null
  state.currentMessageId = currentMessageId != null ? currentMessageId : null
  if (typeof title === 'string' && title) state.historyTitle = title

  dbg(
    `🗂 回补结果 source=${source} code=${json.code} msg=${json.msg || ''} count=${
      messages ? messages.length : 0
    } baseline=${baseline} from=${baselineSource} ctrl=${cacheControl || ''} currentMsg=${
      currentMessageId != null ? currentMessageId : '-'
    } ok=${ok}`
  )
  postToContent('history-baseline', {
    sessionId,
    baseline,
    baselineSource,
    messageCount: messages ? messages.length : 0,
    source,
    // 自动落库校准不能干扰用户手动刷新时的转圈与提示
    auto: source === 'after-turn',
    ok,
    title: typeof title === 'string' ? title : null
  })

  return ok
}

function findMessageArray(node, depth = 0, best = { arr: null, len: 0 }) {
  if (!node || typeof node !== 'object' || depth > 8) return best

  if (Array.isArray(node)) {
    // 放宽校验：多数元素像消息即可，避免一条 tool/system 特殊结构导致整体识别失败
    const hits = node.filter(
      (item) =>
        item &&
        typeof item === 'object' &&
        !Array.isArray(item) &&
        ('content' in item || 'message_id' in item || 'role' in item)
    ).length
    const looksLikeMessages = node.length > 0 && hits >= Math.max(1, Math.ceil(node.length * 0.6))
    if (looksLikeMessages && node.length > best.len) {
      best.arr = node
      best.len = node.length
    }
  }

  for (const value of Object.values(node)) {
    findMessageArray(value, depth + 1, best)
  }
  return best
}

// 只沿白名单字段往下取文本，避免把元数据算进 token
function extractText(node, depth = 0) {
  if (typeof node === 'string') return node
  if (!node || typeof node !== 'object' || depth > 10) return ''

  if (Array.isArray(node)) {
    return node.map((item) => extractText(item, depth + 1)).join('\n')
  }

  let out = ''
  for (const [key, value] of Object.entries(node)) {
    if (CONTENT_KEYS.has(key)) {
      out += extractText(value, depth + 1) + '\n'
    }
  }
  return out
}

function estimateTokens(text) {
  if (!text) return 0
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length
  const rest = text.length - cjk
  return Math.ceil(cjk * 0.6 + rest / 3.5)
}

async function refreshHistory(sessionId) {
  if (!lastHistoryRequest) {
    dbg('🗂 还没有捕获到 history_messages 请求，无法重拉')
    return null
  }

  let url = lastHistoryRequest.url
  if (sessionId) url = replaceParam(url, 'chat_session_id', sessionId)

  const headers = filterReplayHeaders(lastHistoryRequest.headers)
  const target = sessionId || getSessionIdFromUrl(url)

  dbg('🗂 手动重拉历史', { url, target })

  try {
    const res = await origFetch(url, { headers, credentials: 'include' })
    const text = await res.text()
    applyHistory(target, text, 'manual')
    return target
  } catch (err) {
    dbg('🗂 重拉历史失败', err)
    return null
  }
}

// 历史回补的异常兜底：解析失败不应让主动拉取整体 reject
function safeApplyHistory(sessionId, text, source) {
  try {
    return applyHistory(sessionId, text, source)
  } catch (err) {
    dbg('🗂 历史回补解析异常', err)
    return false
  }
}

// 主动拉取：先增量探测（快），无变化就判定已最新；没缓存才落全量（慢）
async function hardRefreshHistory(sessionId, hasCache) {
  const target =
    sessionId ||
    currentSessionId ||
    getSessionIdFromUrl((lastHistoryRequest && lastHistoryRequest.url) || '')
  if (!target || target === 'unknown') {
    dbg('🗂 没有可用的会话 ID，无法主动拉取')
    postToContent('sync-status', { sessionId: sessionId || null, status: 'no-session' })
    return
  }

  const headers = buildAuthHeaders()
  const state = getSession(target)
  state.superseded = false

  // 先按已有会话事实判断：确认是空对话时直接收尾，不再发请求
  let verdict = classifyHistory(target, hasCache)
  if (verdict === 'empty') {
    dbg('🗂 会话事实判定为空对话，快速截断')
    postToContent('sync-status', { sessionId: target, status: 'empty' })
    return
  }

  // 事实不足且页面自身的请求还在进行：给它一个短宽限期，能省掉一次全量下载
  if (verdict === 'unknown' && state.passiveInFlight > 0) {
    dbg('🗂 会话事实不足，等待页面自身历史请求')
    await new Promise((resolve) => setTimeout(resolve, 1200))
    const next = classifyHistory(target, hasCache)
    if (next === 'empty') {
      dbg('🗂 宽限期内确认空对话，快速截断')
      postToContent('sync-status', { sessionId: target, status: 'empty' })
      return
    }
    verdict = next
  }

  // 1) 增量探测：只有上一次历史请求属于同一会话时才能复用它的 cache_version
  const lastUrlSession = lastHistoryRequest && lastHistoryRequest.url
    ? getSessionIdFromUrl(lastHistoryRequest.url)
    : null
  const canIncremental = lastUrlSession === target

  if (canIncremental && lastHistoryRequest && lastHistoryRequest.url) {
    const incUrl = replaceParam(lastHistoryRequest.url, 'chat_session_id', target)
    const incResult = await requestHistory(incUrl, {
      headerTimeout: 4000,
      idleTimeout: 8000,
      totalTimeout: 12000
    })

    if (incResult && !incResult.aborted) {
      const count = incResult.count
      const ctrl = incResult.json ? findFirst(incResult.json, 'cache_control') : ''
      dbg(
        `🗂 增量探测 status=${incResult.status} count=${count} ctrl=${ctrl || ''} len=${
          incResult.text.length
        }`
      )

      if (count > 0) {
        safeApplyHistory(target, incResult.text, 'incremental')
        return
      }

      if (ctrl === 'MERGE') {
        if (hasCache || state.latest != null || state.postTotal != null) {
          dbg('🗂 增量无变化，缓存已是最新')
          postToContent('sync-status', { sessionId: target, status: 'up-to-date' })
          return
        }
        // 无缓存又遇到 MERGE：不能判定为新对话，继续走全量兜底，
        // 否则刚清过缓存的老会话会被误报为“暂无历史数据”
        state.historyCtrl = 'MERGE'
        state.historyCount = count
        dbg('🗂 无缓存但增量为空，转全量确认')
      }
    } else if (incResult && incResult.aborted) {
      dbg(`🗂 增量探测中止（${incResult.reason}），转全量`)
    }
  }

  // 2) 全量兜底：只在无缓存或增量失败时执行
  const finalVerdict = classifyHistory(target, hasCache)
  if (finalVerdict === 'empty') {
    dbg('🗂 增量探测后仍判定为空对话，快速截断')
    postToContent('sync-status', { sessionId: target, status: 'empty' })
    return
  }

  const url = buildHistoryUrl(target)
  dbg('🗂 主动拉取全量历史', { url, hasAuth: !!headers.Authorization })

  // 按会话事实选择超时档位：老对话大包给更长预算，避免弱网误杀
  const timeouts = historyTimeoutsFor(finalVerdict, state)
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  state.activeHistory = controller ? { controller, startedAt: Date.now() } : null

  const result = await requestHistory(url, { ...timeouts, controller })

  state.activeHistory = null

  // 被动请求已经先行拿到数据，主动请求无论成功、失败还是被取消都不再收尾
  if (state.superseded) {
    dbg('🗂 页面自身历史已先行完成，放弃主动拉取')
    return
  }

  if (!result) {
    dbg('🗂 主动拉取失败，回退到请求头复放')
    const fallback = await refreshHistory(target)
    if (!fallback) reportRefreshFailed(target)
    return
  }

  if (result.aborted) {
    dbg(`🗂 全量拉取中止（${result.reason}），终止本次校准`)
    postToContent('sync-status', { sessionId: target, status: 'timeout' })
    return
  }

  dbg(
    `🗂 主动拉取响应 status=${result.status} type=${result.contentType} len=${result.text.length}`
  )

  const messages = result.json ? findMessageArray(result.json).arr : null
  const ok = safeApplyHistory(target, result.text, 'hard-fetch')
  if (!ok) {
    if (!messages || messages.length === 0) {
      dbg('🗂 该会话暂无历史消息，快速截断')
      postToContent('sync-status', { sessionId: target, status: 'empty' })
      return
    }
    dbg('🗂 主动拉取没拿到有效数据，回退到请求头复放')
    const fallback = await refreshHistory(target)
    if (!fallback) reportRefreshFailed(target)
  }
}

// 全量请求超时档位：消息越多，包越大，给越长的 TTFB / 空闲 / 总耗时预算
function historyTimeoutsFor(verdict, state) {
  const count = state.historyCount
  if (verdict === 'history' && count != null && count > 50) {
    return { headerTimeout: 8000, idleTimeout: 15000, totalTimeout: 25000 }
  }
  if (verdict === 'history') {
    return { headerTimeout: 6000, idleTimeout: 10000, totalTimeout: 20000 }
  }
  return { headerTimeout: 4000, idleTimeout: 8000, totalTimeout: 15000 }
}

// 页面自身的被动历史请求：开始/结束计数，成功时通知主动请求收敛
function passiveHistoryStart(sessionId) {
  if (!sessionId || sessionId === 'unknown') return null
  const state = getSession(sessionId)
  state.passiveInFlight = (state.passiveInFlight || 0) + 1
  return state
}

function passiveHistoryEnd(state) {
  if (!state) return
  state.passiveInFlight = Math.max(0, (state.passiveInFlight || 0) - 1)
}

function notifyPassiveResolved(sessionId) {
  if (!sessionId || sessionId === 'unknown') return
  const state = getSession(sessionId)
  state.passiveResolvedAt = Date.now()

  // 主动全量还在跑：直接放弃，省掉一次重复的大包下载
  if (state.activeHistory && state.activeHistory.controller) {
    state.superseded = true
    try {
      state.activeHistory.controller.abort()
    } catch {
      // 已结束
    }
    dbg('🗂 被动历史已返回，取消进行中的主动拉取')
  }
}

// 两条兜底路径都失败时也要让前端收尾，避免转圈干等 30 秒超时
function reportRefreshFailed(sessionId) {
  postToContent('sync-status', { sessionId, status: 'failed' })
}

// 首轮判定阈值：新对话第一轮一问一答通常不超过 4 条消息
const NEW_CONVERSATION_MAX_MESSAGES = 4
const PLACEHOLDER_TITLE_RE = /^(新对话|新的对话|未命名对话|未命名|new chat|new conversation|untitled)$/i

function hasMeaningfulTitle(state) {
  const title = typeof state.historyTitle === 'string' ? state.historyTitle.trim() : ''
  return title.length > 0 && !PLACEHOLDER_TITLE_RE.test(title)
}

// 依据会话事实判断是否“像新对话”：无主线、无有效标题、非 MERGE，且消息数很少
function looksLikeNewConversation(state) {
  return (
    state.currentMessageId == null &&
    !hasMeaningfulTitle(state) &&
    state.historyCtrl !== 'MERGE' &&
    state.historyCount != null &&
    state.historyCount <= NEW_CONVERSATION_MAX_MESSAGES
  )
}

// 基于会话事实判断历史是否存在：history（有内容） / empty（确认新对话） / unknown（无法判定）
function classifyHistory(sessionId, hasCache) {
  const state = getSession(sessionId)
  // 占位标题不算证据，避免新对话被误判成老对话
  const meaningfulTitle = hasMeaningfulTitle(state)

  // 正向证据：服务端有主线/消息，或 MERGE（说明服务端持有快照），或本地/内存已有数据
  const positive =
    (state.historyCount != null && state.historyCount > 0) ||
    state.currentMessageId != null ||
    meaningfulTitle ||
    state.historyCtrl === 'MERGE' ||
    state.hasCompletion ||
    hasCache ||
    state.latest != null ||
    state.postTotal != null

  if (positive) return 'history'

  // 负向证据：已看到明确的空历史响应（非 MERGE、无主线），且从未发过消息
  const negative =
    state.historyCount === 0 &&
    state.historyCtrl !== 'MERGE' &&
    state.currentMessageId == null &&
    !state.hasCompletion

  return negative ? 'empty' : 'unknown'
}

// 一次性探针：判断 history_messages 是否支持 limit 类参数
// 用法：控制台执行 __deepbrim.probeLimit()
async function probeLimit(sessionId) {
  const target =
    sessionId ||
    currentSessionId ||
    getSessionIdFromUrl((lastHistoryRequest && lastHistoryRequest.url) || '')
  if (!target || target === 'unknown') {
    dbg('🔬 没有可用的会话 ID')
    return
  }

  const headers = buildAuthHeaders()
  const base = (lastHistoryRequest && lastHistoryRequest.url) || HISTORY_FALLBACK_PATH
  let baseUrl

  try {
    const parsed = new URL(base, location.href)
    parsed.searchParams.set('chat_session_id', target)
    parsed.searchParams.delete('cache_version')
    parsed.searchParams.delete('cache_reset_at')
    baseUrl = parsed.pathname + parsed.search
  } catch {
    baseUrl = `${HISTORY_PATH}?chat_session_id=${encodeURIComponent(target)}`
  }

  const variants = [
    { label: 'control', query: '', timeout: 15000 },
    { label: 'limit=10', query: 'limit=10', timeout: 5000 },
    { label: 'count=10', query: 'count=10', timeout: 5000 },
    { label: 'page_size=10', query: 'page_size=10', timeout: 5000 }
  ]

  for (const variant of variants) {
    const url = `${baseUrl}${variant.query ? `&${variant.query}` : ''}&_t=${Date.now()}`
    const started = performance.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), variant.timeout)

    try {
      const res = await origFetch(url, {
        method: 'GET',
        headers,
        credentials: 'include',
        signal: controller.signal
      })
      const text = await res.text()
      clearTimeout(timer)

      const json = safeParse(text)
      const arr = json ? findMessageArray(json).arr : null
      const count = arr ? arr.length : 0
      const ctrl = json ? findFirst(json, 'cache_control') : ''
      const lastUsage = arr && arr.length ? findFirst(arr[arr.length - 1], 'accumulated_token_usage') : undefined

      dbg(
        `🔬 probe "${variant.label}" status=${res.status} ms=${Math.round(
          performance.now() - started
        )} len=${text.length} count=${count} ctrl=${ctrl || ''} lastUsage=${lastUsage}`
      )
    } catch (err) {
      clearTimeout(timer)
      dbg(
        `🔬 probe "${variant.label}" ${err && err.name === 'AbortError' ? '超时中止' : '异常'} after ${Math.round(
          performance.now() - started
        )}ms`
      )
    }
  }

  dbg('🔬 probe 结束：若某个参数 len/ms 明显小于 control 且 count≈10，说明该参数生效')
}

function buildHistoryUrl(sessionId) {
  const base = (lastHistoryRequest && lastHistoryRequest.url) || HISTORY_FALLBACK_PATH
  try {
    const parsed = new URL(base, location.href)
    parsed.searchParams.set('chat_session_id', sessionId)
    // 去掉缓存协商参数，避免服务端按 MERGE 只回增量（会拿到空 chat_messages）
    parsed.searchParams.delete('cache_version')
    parsed.searchParams.delete('cache_reset_at')
    parsed.searchParams.set('_t', String(Date.now()))
    return parsed.pathname + parsed.search
  } catch {
    return `${HISTORY_FALLBACK_PATH}?chat_session_id=${encodeURIComponent(sessionId)}&_t=${Date.now()}`
  }
}

// 增量模板：沿用真实请求的路径，避免 API 版本变化后写死的路径失效
function buildIncrementalUrl(baseUrl, sessionId, cacheVersion, cacheResetAt) {
  try {
    const parsed = new URL(baseUrl, location.href)
    parsed.searchParams.set('chat_session_id', sessionId)
    parsed.searchParams.set('cache_version', String(cacheVersion))
    parsed.searchParams.set('cache_reset_at', String(cacheResetAt != null ? cacheResetAt : 0))
    parsed.searchParams.delete('_t')
    return parsed.pathname + parsed.search
  } catch {
    return `${HISTORY_FALLBACK_PATH}?chat_session_id=${encodeURIComponent(
      sessionId
    )}&cache_version=${cacheVersion}&cache_reset_at=${cacheResetAt || 0}`
  }
}

function buildAuthHeaders() {
  const headers = filterReplayHeaders((lastHistoryRequest && lastHistoryRequest.headers) || {})

  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'authorization') delete headers[key]
  }

  const token = lastAuthHeader || findTokenFromStorage()
  if (token) headers.Authorization = /^Bearer\s/i.test(token) ? token : `Bearer ${token}`

  headers['Content-Type'] = 'application/json'
  return headers
}

// 兜底：从 localStorage 里找疑似 token 的值
// 先用 key 白名单缩小范围，再用值的结构校验，避免拿到 csrf / theme 之类的假 token
const TOKEN_KEY_DENY_RE = /csrf|theme|i18n|temp|nonce|state|verifier|pkce|locale|settings|banner|report|device|expire/i

function findTokenFromStorage() {
  try {
    const candidates = []

    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)
      if (!key) continue

      const lower = key.toLowerCase()
      if (TOKEN_KEY_DENY_RE.test(lower)) continue
      if (!/token|auth|credential|jwt/i.test(lower)) continue

      const raw = localStorage.getItem(key)
      if (!raw || raw.length < 20) continue

      let value = raw
      try {
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed === 'object') {
          value = parsed.value || parsed.token || parsed.access_token || ''
        }
      } catch {
        // 不是 JSON，按原字符串用
      }

      if (typeof value !== 'string') continue
      value = value.trim()
      if (!looksLikeToken(value)) continue

      // 越像 Bearer / access_token 的 key，优先级越高
      const score = /authorization|access_token|auth_token|bearer/i.test(lower) ? 3 : 2
      candidates.push({ value, score })
    }

    if (!candidates.length) return null
    candidates.sort((a, b) => b.score - a.score)
    return candidates[0].value
  } catch {
    // 读取失败就放弃，交给 replay 兜底
  }
  return null
}

function looksLikeToken(value) {
  if (/^Bearer\s+[A-Za-z0-9._~+/=-]{20,}$/i.test(value)) return true
  // JWT：三段 base64url
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) return true
  // 不透明长 token（兼容 base64 标准字符）
  return /^[A-Za-z0-9._~+/=-]{32,}$/.test(value)
}



/* ---------------- fetch hook ---------------- */

const origFetch = window.fetch

window.fetch = async function (input, init) {
  const response = await origFetch.apply(this, arguments)

  try {
    const url = typeof input === 'string' ? input : input && input.url
    if (DEBUG && url && (url.includes(COMPLETION_PATH) || url.includes(HISTORY_PATH))) {
      dbg('🔍 fetch:', url)
    }
    if (!url) return response

    const isCompletion = url.includes(COMPLETION_PATH)
    const isHistory = url.includes(HISTORY_PATH)
    if (!isCompletion && !isHistory) return response

    // fetch 侧同样记录请求头，避免站点迁移后鉴权只能靠 localStorage 兜底
    const requestHeaders = captureRequestHeaders(input, init)
    rememberAuthHeader(requestHeaders)

    if (isHistory) {
      captureHistoryResponse(url, response, requestHeaders)
      return response
    }

    const contentType = response.headers.get('content-type') || ''
    if (!contentType.includes('text/event-stream') || !response.body) {
      dbg('命中 completion(fetch) 但响应不是 SSE，已跳过', url)
      return response
    }

    const sessionId = parseSessionId(await readRequestBody(input, init))
    if (!sessionId) {
      dbg('🎯 completion(fetch) 请求体缺 chat_session_id，跳过本轮统计')
      return response
    }
    dbg('🎯 拦截到 completion（fetch）', { sessionId, url })
    currentSessionId = sessionId
    getSession(sessionId).hasCompletion = true

    // clone() 拿到第二份流，页面继续消费原响应，互不影响
    const parser = createSseParser(sessionId)
    parseStream(response.clone().body, parser)
  } catch (err) {
    dbg('fetch 拦截异常，已放行原响应', err)
  }

  return response
}

// fetch 的 headers 可能是 Headers / 数组 / 普通对象，统一转成可复放的字典
function captureRequestHeaders(input, init) {
  const out = {}

  try {
    let source = null
    if (init && init.headers) source = init.headers
    else if (typeof Request !== 'undefined' && input instanceof Request) source = input.headers
    if (!source) return out

    const headers = new Headers(source)
    headers.forEach((value, key) => {
      out[key] = value
    })
  } catch {
    // 解析失败时返回空字典，仍可依赖 XHR 路径
  }

  return out
}

function rememberAuthHeader(headers) {
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === 'authorization' && typeof value === 'string' && value) {
      lastAuthHeader = value
    }
  }
}

// 历史请求可能是 fetch：读取 clone 响应体，与 XHR 路径共用同一套回补逻辑
function captureHistoryResponse(url, response, headers) {
  const sessionId = getSessionIdFromUrl(url)
  const passiveState = passiveHistoryStart(sessionId)

  try {
    response
      .clone()
      .text()
      .then((text) => {
        if (!text) return
        lastHistoryRequest = { url: absoluteUrl(url), headers }
        dbg('🗂 捕获到 history_messages 响应（fetch）', { sessionId })
        const ok = applyHistory(sessionId, text, 'page')
        // 被动响应成功应用：通知正在进行的主动全量请求让路
        if (ok) notifyPassiveResolved(sessionId)
      })
      .catch((err) => dbg('🗂 fetch 历史响应读取失败', err))
      .finally(() => passiveHistoryEnd(passiveState))
  } catch (err) {
    passiveHistoryEnd(passiveState)
    dbg('🗂 fetch 历史响应捕获失败', err)
  }
}

function absoluteUrl(url) {
  try {
    return new URL(url, location.href).href
  } catch {
    return url
  }
}

async function readRequestBody(input, init) {
  if (init && typeof init.body === 'string') return init.body
  if (typeof Request !== 'undefined' && input instanceof Request) {
    try {
      return await input.clone().text()
    } catch {
      return ''
    }
  }
  return ''
}

async function parseStream(stream, parser) {
  const reader = stream.getReader()
  const decoder = new TextDecoder('utf-8')

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      parser.push(decoder.decode(value, { stream: true }))
    }
  } catch (err) {
    dbg('SSE 解析中断（用户停止或网络抖动），仍尝试收尾', err)
    // 中断不参与契约告警计数，避免把自动重连抖动误判为站点改版
    if (typeof parser.abort === 'function') parser.abort()
  } finally {
    // 必须收尾：否则本轮不结束、下一轮的本轮值会虚高
    try {
      const tail = decoder.decode()
      if (tail) parser.push(tail)
      parser.flush()
    } catch (err) {
      dbg('flush 失败', err)
    }
  }
}

/* ---------------- XHR hook ---------------- */

const origOpen = XMLHttpRequest.prototype.open
const origSend = XMLHttpRequest.prototype.send
const origSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader

XMLHttpRequest.prototype.open = function (method, url) {
  this.__deepbrimUrl = typeof url === 'string' ? url : String(url)
  return origOpen.apply(this, arguments)
}

XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
  try {
    if (typeof name === 'string' && name.toLowerCase() === 'authorization') {
      lastAuthHeader = value
    }
    if (!this.__deepbrimHeaders) this.__deepbrimHeaders = {}
    this.__deepbrimHeaders[name] = value
  } catch {
    // 记录失败不影响原请求
  }
  return origSetRequestHeader.apply(this, arguments)
}

XMLHttpRequest.prototype.send = function (body) {
  try {
    const url = this.__deepbrimUrl || ''
    if (DEBUG && (url.includes(COMPLETION_PATH) || url.includes(HISTORY_PATH))) {
      dbg('🔍 xhr:', url)
    }

    if (url.includes(COMPLETION_PATH)) {
      attachCompletionParser(this, url, body)
    } else if (url.includes(HISTORY_PATH)) {
      attachHistoryCapture(this, url)
    }
  } catch (err) {
    dbg('XHR 拦截异常，已放行原请求', err)
  }

  return origSend.apply(this, arguments)
}

function attachCompletionParser(xhr, url, body) {
  const sessionId = parseSessionId(typeof body === 'string' ? body : '')

  // 宁可这轮不统计，也不能把数据记到错误会话上
  if (!sessionId) {
    dbg('🎯 completion 请求体缺 chat_session_id，跳过本轮统计')
    return
  }

  currentSessionId = sessionId
  getSession(sessionId).hasCompletion = true
  dbg('🎯 拦截到 completion（xhr）', { sessionId, url })

  const parser = createSseParser(sessionId)
  let consumed = 0

  // SSE 走 readyState 3 渐进返回，用 progress 逐段读新增部分
  xhr.addEventListener('progress', () => {
    if (xhr.responseType && xhr.responseType !== 'text') return
    try {
      const text = xhr.responseText || ''
      if (text.length > consumed) {
        parser.push(text.slice(consumed))
        consumed = text.length
      }
    } catch (err) {
      dbg('读取 XHR responseText 失败', err)
    }
  })

  // 用户停止生成或网络中断：标记为中断，不参与契约告警计数
  xhr.addEventListener('error', () => parser.abort())
  xhr.addEventListener('abort', () => parser.abort())

  xhr.addEventListener('loadend', () => {
    try {
      if ((!xhr.responseType || xhr.responseType === 'text') && xhr.responseText) {
        const text = xhr.responseText
        if (text.length > consumed) {
          parser.push(text.slice(consumed))
          consumed = text.length
        }
      }
    } catch (err) {
      dbg('loadend 读取失败', err)
    }
    parser.flush()
  })
}

function attachHistoryCapture(xhr, url) {
  const sessionId = getSessionIdFromUrl(url)
  const passiveState = passiveHistoryStart(sessionId)

  xhr.addEventListener('loadend', () => {
    try {
      const text =
        xhr.responseType === 'json'
          ? JSON.stringify(xhr.response)
          : !xhr.responseType || xhr.responseType === 'text'
            ? xhr.responseText
            : ''
      if (!text) return

      lastHistoryRequest = { url, headers: xhr.__deepbrimHeaders || {} }
      dbg('🗂 捕获到 history_messages 响应', { sessionId })
      const ok = applyHistory(sessionId, text, 'page')
      // 被动响应成功应用：通知正在进行的主动全量请求让路
      if (ok) notifyPassiveResolved(sessionId)
    } catch (err) {
      dbg('历史响应解析失败', err)
    } finally {
      passiveHistoryEnd(passiveState)
    }
  })
}

/* ---------------- 工具函数 ---------------- */

function parseSessionId(text) {
  const id = safeParse(text)?.chat_session_id
  return typeof id === 'string' && id.length > 0 ? id : null
}

function getSessionIdFromUrl(url) {
  try {
    return new URL(url, location.href).searchParams.get('chat_session_id') || 'unknown'
  } catch {
    return 'unknown'
  }
}

function replaceParam(url, key, value) {
  try {
    const parsed = new URL(url, location.href)
    parsed.searchParams.set(key, value)
    return parsed.pathname + parsed.search
  } catch {
    return url
  }
}

// 复放时剔除浏览器不允许脚本设置的请求头
const FORBIDDEN_HEADERS = new Set([
  'cookie',
  'content-length',
  'host',
  'connection',
  'user-agent',
  'referer',
  'accept-encoding',
  'origin'
])

function filterReplayHeaders(headers) {
  const out = {}
  for (const [key, value] of Object.entries(headers || {})) {
    if (!FORBIDDEN_HEADERS.has(key.toLowerCase())) out[key] = value
  }
  return out
}

function safeParse(text) {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// 递归找字段，不写死路径
function findFirst(node, key, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return undefined

  if (!Array.isArray(node) && key in node) return node[key]

  const values = Array.isArray(node) ? node : Object.values(node)
  for (const value of values) {
    const hit = findFirst(value, key, depth + 1)
    if (hit !== undefined) return hit
  }
  return undefined
}

// 递归识别 SSE 补丁结构 {p:'字段名', v:值}，兼容字段路径式增量下发
// 同一帧内出现多个同名字段时保留最后一个
function findPatchValue(node, pathName) {
  let result

  const walk = (current, depth) => {
    if (!current || typeof current !== 'object' || depth > 8) return

    if (!Array.isArray(current) && current.p === pathName) result = current.v

    const values = Array.isArray(current) ? current : Object.values(current)
    for (const value of values) walk(value, depth + 1)
  }

  walk(node, 0)
  return result
}

// 先按 key 查找，再按补丁 p/v 查找，两种下发格式都兼容
function findField(node, key) {
  const direct = findFirst(node, key)
  if (direct !== undefined) return direct
  return findPatchValue(node, key)
}

function postToContent(type, payload) {
  window.postMessage({ source: 'deepbrim', type, payload }, location.origin)
}

// 控制台调试入口：只暴露脱敏视图，随调试开关动态挂载/卸载
function installDebugApi() {
  if (window.__deepbrim) return
  window.__deepbrim = {
    refreshHistory,
    probeLimit,
    state: (sessionId) => {
      if (sessionId) {
        const session = sessions.get(sessionId)
        return session
          ? { latest: session.latest, postTotal: session.postTotal, fileCount: session.files.length }
          : null
      }
      return { sessionCount: sessions.size }
    }
  }
}

function uninstallDebugApi() {
  try {
    delete window.__deepbrim
  } catch {
    // 忽略
  }
}

if (DEBUG) installDebugApi()

// 浮层（isolated world）请求重拉 / 主动拉取历史 / 切换调试日志
window.addEventListener('message', (event) => {
  if (event.source !== window) return
  const data = event.data
  if (!data) return

  // 只接受浮层（isolated world）发来的指令
  if (data.source !== 'deepbrim-ui') return

  if (data.type === 'toggle-debug') {
    const enabled = !!data.enabled
    const changed = enabled !== DEBUG
    DEBUG = enabled

    if (enabled) {
      installDebugApi()
      // 初始化阶段可能收到多次相同状态，只在真正切换时提示一次
      if (changed) dbg('🛠️ 开发者调试模式已开启，将输出详细底层日志')
    } else {
      uninstallDebugApi()
    }
    return
  }

  if (data.type === 'refresh') {
    refreshHistory(data.sessionId || currentSessionId)
  }

  if (data.type === 'hard-refresh') {
    hardRefreshHistory(data.sessionId || currentSessionId, data.hasCache)
  }
})

// 页面加载时向浮层询问当前调试状态，避免与设置页的初始化消息错过
window.postMessage({ source: 'deepbrim', type: 'debug-state-request' }, location.origin)

dbg('inject.js 已注入 MAIN world（fetch + xhr + 历史回补）')
