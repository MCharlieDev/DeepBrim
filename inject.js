// DeepBrim - 核心脚本（MAIN world）
// 阶段 2：fetch + XHR 拦截、SSE 真值解析、历史回补（history_messages 基线估算）

const TAG = '[DeepBrim]'
const COMPLETION_PATH = '/chat/completion'
const HISTORY_PATH = '/chat/history_messages'
const DEBUG = true
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

function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      latest: null,
      postTotal: null,
      prevPostTotal: null,
      files: []
    })
  }
  return sessions.get(sessionId)
}

/* ---------------- SSE 解析器（fetch / XHR 共用） ---------------- */

function createSseParser(sessionId) {
  const state = getSession(sessionId)
  let buffer = ''
  let rawTail = ''

  return {
    push(text) {
      if (!text) return
      rawTail = (rawTail + text).slice(-RAW_TAIL_LIMIT)
      buffer += text

      let splitIndex = buffer.indexOf('\n\n')
      while (splitIndex !== -1) {
        const frame = buffer.slice(0, splitIndex)
        buffer = buffer.slice(splitIndex + 2)
        handleFrame(frame, sessionId, state)
        splitIndex = buffer.indexOf('\n\n')
      }
    },
    flush() {
      if (buffer.trim()) {
        handleFrame(buffer, sessionId, state)
        buffer = ''
      }
      // 兜底：整段响应不是标准 SSE 时，直接从原文里抓最后一个数字
      if (state.latest === null) {
        const matches = [...rawTail.matchAll(/"accumulated_token_usage"\s*:\s*(\d+)/g)]
        const last = matches.length ? Number(matches[matches.length - 1][1]) : null
        if (last !== null) {
          state.latest = last
          console.log(TAG, '📊 兜底抓到 accumulated_token_usage =', last)
        }
      }
      reportEnd(sessionId, state)
    }
  }
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

  // 附件：官方直接给 token_usage
  if (event === 'update_file') {
    const tokens = findFirst(json, 'token_usage')
    if (typeof tokens === 'number') {
      const isImage = findFirst(json, 'is_image') === true
      state.files.push({ tokens, isImage })
      console.log(TAG, '📎 附件用量', { tokens, isImage })
      postToContent('file-usage', { sessionId, tokens, isImage })
    }
    return
  }

  // 主路径：累计用量
  const usage = findFirst(json, 'accumulated_token_usage')
  // 0 是首轮早期的占位值，不作为有效统计
  if (typeof usage === 'number' && usage > 0 && state.latest !== usage) {
    state.latest = usage
    console.log(TAG, '📊 accumulated_token_usage =', usage)
    postToContent('usage', {
      sessionId,
      total: usage
    })
  }
}

function reportEnd(sessionId, state) {
  console.log(TAG, '🎉 数据流读取完毕', {
    sessionId,
    promptTotal: state.latest,
    postTotal: state.postTotal,
    attachments: state.files
  })

  postToContent('stream-end', {
    sessionId,
    total: state.latest,
    attachmentTokens: state.files.reduce((sum, f) => sum + (f.tokens || 0), 0)
  })

  if (state.latest != null) {
    // 稍等片刻再校准，避免服务端尚未落库时拿到旧快照
    setTimeout(() => syncAfterTurn(sessionId), 600)
  }
}

// 生成结束后静默校准：拿到落库后的真实总量（含本轮回复）
async function syncAfterTurn(sessionId) {
  const before = getSession(sessionId).postTotal
  const hasTemplate =
    !!lastHistoryRequest &&
    !!lastHistoryRequest.url &&
    getSessionIdFromUrl(lastHistoryRequest.url) === sessionId

  // 新对话没有可复用的历史请求模板，改用一次全量请求（此时消息很少，成本低）
  const url = hasTemplate ? replaceParam(lastHistoryRequest.url, 'chat_session_id', sessionId) : buildHistoryUrl(sessionId)

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), hasTemplate ? 8000 : 4000) : null

  try {
    const res = await origFetch(url, {
      method: 'GET',
      headers: buildAuthHeaders(),
      credentials: 'include',
      signal: controller ? controller.signal : undefined
    })
    if (!res.ok) return

    const text = await res.text()
    const json = safeParse(text)
    const count = json ? (findMessageArray(json).arr || []).length : 0
    if (count <= 0) {
      console.log(TAG, '🗂 落库校准：没有新消息，跳过')
      return
    }

    const ok = applyHistory(sessionId, text, 'after-turn')
    if (!ok) return

    // 全量请求没有版本号，若响应里带回版本信息，就把它沉淀成后续增量模板
    if (!hasTemplate && json) {
      const cacheVersion = findFirst(json, 'cache_version')
      if (cacheVersion != null) {
        lastHistoryRequest = {
          url: `/api/v0/chat/history_messages?chat_session_id=${sessionId}&cache_version=${cacheVersion}&cache_reset_at=${findFirst(json, 'cache_reset_at') || 0}`,
          headers: lastHistoryRequest ? lastHistoryRequest.headers : {}
        }
        console.log(TAG, `🗂 已沉淀增量模板 cache_version=${cacheVersion}`)
      }
    }

    const state = getSession(sessionId)
    const total = state.postTotal
    // 只有真正向前增长才算本轮；0 或负数视为尚未落库，不覆盖已有本轮值
    const roundTokens = before != null && total != null && total > before ? total - before : null

    console.log(TAG, `🗂 落库校准 total=${total} prev=${before} round=${roundTokens} via=${hasTemplate ? 'incremental' : 'full'}`)

    postToContent('post-turn', {
      sessionId,
      total,
      roundTokens,
      roundSource: roundTokens != null ? 'post-turn' : 'unknown'
    })
  } catch (err) {
    console.warn(TAG, '🗂 落库校准失败（不影响主流程）', err)
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/* ---------------- 历史回补 ---------------- */

function applyHistory(sessionId, text, source) {
  if (!sessionId || sessionId === 'unknown') {
    console.warn(TAG, '🗂 历史响应缺少有效会话 ID，已丢弃')
    return false
  }

  const json = safeParse(text)
  if (!json) {
    console.warn(TAG, '🗂 历史响应不是 JSON，无法回补')
    return
  }

  const { arr: messages } = findMessageArray(json)

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
    } else {
      // 所有消息都没有该字段时才做文本估算
      baseline = messages.reduce((sum, msg) => sum + estimateTokens(extractText(msg)), 0)
      baselineSource = baseline > 0 ? 'estimate' : 'unknown'
    }
  }

  // 0 不是有效基线：新对话或消息尚未落库时，宁可不显示也不显示 0
  if (typeof baseline === 'number' && baseline <= 0) {
    baseline = null
    baselineSource = 'unknown'
  }

  const state = getSession(sessionId)
  currentSessionId = sessionId
  state.postTotal = baseline
  state.prevPostTotal = baseline
  if (baseline != null && state.latest === null) state.latest = baseline

  const ok = baseline != null || (messages && messages.length > 0)
  const title = findFirst(json, 'title')
  const cacheControl = findFirst(json, 'cache_control')

  console.log(
    TAG,
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
    ok,
    title: typeof title === 'string' ? title : null
  })

  return ok
}

function findMessageArray(node, depth = 0, best = { arr: null, len: 0 }) {
  if (!node || typeof node !== 'object' || depth > 8) return best

  if (Array.isArray(node)) {
    const looksLikeMessages =
      node.length > 0 &&
      node.every(
        (item) =>
          item &&
          typeof item === 'object' &&
          !Array.isArray(item) &&
          ('content' in item || 'message_id' in item || 'role' in item)
      )
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
    console.warn(TAG, '🗂 还没有捕获到 history_messages 请求，无法重拉')
    return null
  }

  let url = lastHistoryRequest.url
  if (sessionId) url = replaceParam(url, 'chat_session_id', sessionId)

  const headers = filterReplayHeaders(lastHistoryRequest.headers)
  const target = sessionId || getSessionIdFromUrl(url)

  console.log(TAG, '🗂 手动重拉历史', { url, target })

  try {
    const res = await origFetch(url, { headers, credentials: 'include' })
    const text = await res.text()
    applyHistory(target, text, 'manual')
    return target
  } catch (err) {
    console.warn(TAG, '🗂 重拉历史失败', err)
    return null
  }
}

// 主动拉取：先增量探测（快），无变化就判定已最新；没缓存才落全量（慢）
async function hardRefreshHistory(sessionId, hasCache) {
  const target =
    sessionId ||
    currentSessionId ||
    getSessionIdFromUrl((lastHistoryRequest && lastHistoryRequest.url) || '')
  if (!target || target === 'unknown') {
    console.warn(TAG, '🗂 没有可用的会话 ID，无法主动拉取')
    postToContent('sync-status', { sessionId: sessionId || null, status: 'no-session' })
    return
  }

  const headers = buildAuthHeaders()

  // 1) 增量探测：只有上一次历史请求属于同一会话时才能复用它的 cache_version
  const lastUrlSession = lastHistoryRequest && lastHistoryRequest.url
    ? getSessionIdFromUrl(lastHistoryRequest.url)
    : null
  const canIncremental = lastUrlSession === target

  if (canIncremental && lastHistoryRequest && lastHistoryRequest.url) {
    const incUrl = replaceParam(lastHistoryRequest.url, 'chat_session_id', target)
    try {
      const res = await origFetch(incUrl, { method: 'GET', headers, credentials: 'include' })
      const text = await res.text()
      const json = safeParse(text)
      const arr = json ? findMessageArray(json).arr : null
      const count = arr ? arr.length : 0
      const ctrl = json ? findFirst(json, 'cache_control') : ''

      console.log(TAG, `🗂 增量探测 status=${res.status} count=${count} ctrl=${ctrl || ''} len=${text.length}`)

      if (res.ok && count > 0) {
        applyHistory(target, text, 'incremental')
        return
      }

      if (res.ok && ctrl === 'MERGE') {
        const state = getSession(target)
        if (hasCache || state.latest != null || state.postTotal != null) {
          console.log(TAG, '🗂 增量无变化，缓存已是最新')
          postToContent('sync-status', { sessionId: target, status: 'up-to-date' })
          return
        }
        // 无缓存且增量无变化：新对话，直接收尾，不再触发全量
        if (count === 0) {
          console.log(TAG, '🗂 新对话无历史数据，快速截断')
          postToContent('sync-status', { sessionId: target, status: 'empty' })
          return
        }
      }
    } catch (err) {
      console.warn(TAG, '🗂 增量探测异常，转全量', err)
    }
  }

  // 2) 全量兜底：只在无缓存或增量失败时执行
  const url = buildHistoryUrl(target)
  console.log(TAG, '🗂 主动拉取全量历史', { url, hasAuth: !!headers.Authorization })

  try {
    const res = await origFetch(url, { method: 'GET', headers, credentials: 'include' })
    const text = await res.text()
    console.log(
      TAG,
      `🗂 主动拉取响应 status=${res.status} type=${res.headers.get('content-type')} len=${text.length}`
    )

    if (!res.ok) {
      console.warn(TAG, '🗂 主动拉取失败，回退到请求头复放')
      await refreshHistory(target)
      return
    }

    const messages = findMessageArray(safeParse(text)).arr
    const ok = applyHistory(target, text, 'hard-fetch')
    if (!ok) {
      if (!messages || messages.length === 0) {
        console.warn(TAG, '🗂 该会话暂无历史消息，快速截断')
        postToContent('sync-status', { sessionId: target, status: 'empty' })
        return
      }
      console.warn(TAG, '🗂 主动拉取没拿到有效数据，回退到请求头复放')
      await refreshHistory(target)
    }
  } catch (err) {
    console.warn(TAG, '🗂 主动拉取异常，回退到请求头复放', err)
    await refreshHistory(target)
  }
}

// 一次性探针：判断 history_messages 是否支持 limit 类参数
// 用法：控制台执行 __deepbrim.probeLimit()
async function probeLimit(sessionId) {
  const target =
    sessionId ||
    currentSessionId ||
    getSessionIdFromUrl((lastHistoryRequest && lastHistoryRequest.url) || '')
  if (!target || target === 'unknown') {
    console.warn(TAG, '🔬 没有可用的会话 ID')
    return
  }

  const headers = buildAuthHeaders()
  const base = (lastHistoryRequest && lastHistoryRequest.url) || HISTORY_PATH
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

      console.log(
        TAG,
        `🔬 probe "${variant.label}" status=${res.status} ms=${Math.round(
          performance.now() - started
        )} len=${text.length} count=${count} ctrl=${ctrl || ''} lastUsage=${lastUsage}`
      )
    } catch (err) {
      clearTimeout(timer)
      console.log(
        TAG,
        `🔬 probe "${variant.label}" ${err && err.name === 'AbortError' ? '超时中止' : '异常'} after ${Math.round(
          performance.now() - started
        )}ms`
      )
    }
  }

  console.log(TAG, '🔬 probe 结束：若某个参数 len/ms 明显小于 control 且 count≈10，说明该参数生效')
}

function buildHistoryUrl(sessionId) {
  const base = (lastHistoryRequest && lastHistoryRequest.url) || HISTORY_PATH
  try {
    const parsed = new URL(base, location.href)
    parsed.searchParams.set('chat_session_id', sessionId)
    // 去掉缓存协商参数，避免服务端按 MERGE 只回增量（会拿到空 chat_messages）
    parsed.searchParams.delete('cache_version')
    parsed.searchParams.delete('cache_reset_at')
    parsed.searchParams.set('_t', String(Date.now()))
    return parsed.pathname + parsed.search
  } catch {
    return `${HISTORY_PATH}?chat_session_id=${encodeURIComponent(sessionId)}&_t=${Date.now()}`
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
    if (DEBUG && url && url.includes('/api/')) {
      console.log(TAG, '🔍 fetch:', url)
    }
    if (!url || !url.includes(COMPLETION_PATH)) return response

    const contentType = response.headers.get('content-type') || ''
    if (!contentType.includes('text/event-stream') || !response.body) {
      console.log(TAG, '命中 completion(fetch) 但响应不是 SSE，已跳过', url)
      return response
    }

    const sessionId = parseSessionId(await readRequestBody(input, init))
    if (!sessionId) {
      console.warn(TAG, '🎯 completion(fetch) 请求体缺 chat_session_id，跳过本轮统计')
      return response
    }
    console.log(TAG, '🎯 拦截到 completion（fetch）', { sessionId, url })

    // clone() 拿到第二份流，页面继续消费原响应，互不影响
    const parser = createSseParser(sessionId)
    parseStream(response.clone().body, parser)
  } catch (err) {
    console.warn(TAG, 'fetch 拦截异常，已放行原响应', err)
  }

  return response
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
    console.warn(TAG, 'SSE 解析中断（用户停止或网络抖动），仍尝试收尾', err)
  } finally {
    // 必须收尾：否则本轮不结束、下一轮的本轮值会虚高
    try {
      parser.flush()
    } catch (err) {
      console.warn(TAG, 'flush 失败', err)
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
    if (DEBUG && url.includes('/api/')) {
      console.log(TAG, '🔍 xhr:', url)
    }

    if (url.includes(COMPLETION_PATH)) {
      attachCompletionParser(this, url, body)
    } else if (url.includes(HISTORY_PATH)) {
      attachHistoryCapture(this, url)
    }
  } catch (err) {
    console.warn(TAG, 'XHR 拦截异常，已放行原请求', err)
  }

  return origSend.apply(this, arguments)
}

function attachCompletionParser(xhr, url, body) {
  const sessionId = parseSessionId(typeof body === 'string' ? body : '')

  // 宁可这轮不统计，也不能把数据记到错误会话上
  if (!sessionId) {
    console.warn(TAG, '🎯 completion 请求体缺 chat_session_id，跳过本轮统计')
    return
  }

  currentSessionId = sessionId
  console.log(TAG, '🎯 拦截到 completion（xhr）', { sessionId, url })

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
      console.warn(TAG, '读取 XHR responseText 失败', err)
    }
  })

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
      console.warn(TAG, 'loadend 读取失败', err)
    }
    parser.flush()
  })
}

function attachHistoryCapture(xhr, url) {
  const sessionId = getSessionIdFromUrl(url)

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
      console.log(TAG, '🗂 捕获到 history_messages 响应', { sessionId })
      applyHistory(sessionId, text, 'page')
    } catch (err) {
      console.warn(TAG, '历史响应解析失败', err)
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

function postToContent(type, payload) {
  window.postMessage({ source: 'deepbrim', type, payload }, '*')
}

// 控制台调试入口：__deepbrim.refreshHistory('会话ID')
window.__deepbrim = {
  refreshHistory,
  probeLimit,
  state: (sessionId) => sessions.get(sessionId) || sessions
}

// 浮层（isolated world）请求重拉 / 主动拉取历史
window.addEventListener('message', (event) => {
  if (event.source !== window) return
  const data = event.data
  if (!data || data.source !== 'deepbrim-ui') return

  if (data.type === 'refresh') {
    refreshHistory(data.sessionId || currentSessionId)
  }

  if (data.type === 'hard-refresh') {
    hardRefreshHistory(data.sessionId || currentSessionId, data.hasCache)
  }
})

console.log(TAG, 'inject.js 已注入 MAIN world（fetch + xhr + 历史回补）')
