// DeepBrim - 浮层（isolated world）
// 圆盘 + 右键面板；面板内分「数据」与「设置」两个视图
// 缓存按会话逐条管理，官方真值与历史估算分开存，官方优先

const TAG = '[DeepBrim]'
const DEFAULT_LIMIT = 1000000
const LIMIT_MIN = 1000
const LIMIT_MAX = 10000000
const PRESETS = [1000000, 128000, 64000]
const POS_KEY = 'deepbrim.pos'
const LIMIT_KEY = 'deepbrim.limit'
const THEME_KEY = 'deepbrim.theme'
const CACHE_PREFIX = 'deepbrim.cache.'
const CACHE_DEBOUNCE = 2000
const URL_POLL_MS = 500

const state = {
  sessionId: null,
  limit: DEFAULT_LIMIT,
  officialTotal: null,
  officialPrevTotal: null,
  baselineValue: null,
  baselineSource: null,
  roundTokens: null,
  roundSource: null,
  attachmentTokens: null,
  messageCount: null,
  updatedAt: null,
  fromCache: false,
  title: null
}

let host
let shadow
let disc
let ring
let pctEl
let absEl
let toastEl
let panel
let confirmEl
let settingsModal
let settingsBackdrop
let settingsTab = 'basic'
let themeChoice = 'auto'
let themeObserver = null
let bodyThemeObserved = false
let dragging = false
let cacheTimer = null
let cacheLoadToken = 0
let toastTimer = null
let pendingTimer = null
let pendingSlowTimer = null
let pendingDeleteId = null
let pendingHardRefresh = false

init()

function init() {
  host = document.createElement('div')
  host.id = 'deepbrim-host'
  shadow = host.attachShadow({ mode: 'open' })
  shadow.innerHTML = template()
  // 先按系统偏好给一个占位主题，避免挂载瞬间闪白
  host.setAttribute(
    'data-db-theme',
    matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  )

  disc = shadow.querySelector('.db-disc')
  ring = shadow.querySelector('.db-ring')
  pctEl = shadow.querySelector('.db-pct')
  absEl = shadow.querySelector('.db-abs')
  toastEl = shadow.querySelector('.db-toast')
  panel = shadow.querySelector('.db-panel')
  confirmEl = shadow.querySelector('.db-confirm')
  settingsModal = shadow.querySelector('.db-settings-modal')
  settingsBackdrop = shadow.querySelector('.db-settings-backdrop')

  // 面板内容异步变化（缓存列表加载、提示文字出现）时，重新校正位置防止溢出
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => {
      if (panel.classList.contains('db-open')) ensurePanelInView()
    }).observe(panel)
  }

  bindEvents()
  startUrlPolling()
  syncLimitSelect()

  // document_start 阶段 documentElement 不保证已存在，等挂载成功后再布局
  mountWhenReady(() => {
    const initialId = getSessionIdFromLocation()
    if (initialId) switchSession(initialId)
    restorePosition()
    initTheme()
    render()
  })
}

function mountWhenReady(onMounted) {
  const mount = () => {
    document.documentElement.appendChild(host)
    onMounted()
  }

  if (document.documentElement) {
    mount()
    return
  }

  const observer = new MutationObserver(() => {
    if (!document.documentElement) return
    observer.disconnect()
    mount()
  })
  observer.observe(document, { childList: true, subtree: true })
}

function template() {
  return `
    <style>
      :host { all: initial; }
      *, *::before, *::after { box-sizing: border-box; }
      .db-disc {
        position: fixed;
        left: calc(100% - 80px);
        top: calc(100% - 152px);
        width: 56px;
        height: 56px;
        border-radius: 50%;
        background: #fff;
        box-shadow: 0 4px 16px rgba(0, 0, 0, .16);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        user-select: none;
        touch-action: none;
        z-index: 2147483000;
        font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
      }
      .db-disc.db-spin-once .db-ring { animation: db-spin .6s cubic-bezier(.4, 0, .2, 1); }
      .db-disc.db-spinning .db-ring {
        animation: db-spin .9s linear infinite;
        opacity: .3;
      }
      @keyframes db-spin {
        from { transform: rotate(-90deg); }
        to { transform: rotate(270deg); }
      }
      .db-ring {
        transform-box: fill-box;
        transform-origin: center;
        transform: rotate(-90deg);
        transition: stroke .2s ease, stroke-dashoffset .4s ease;
      }
      .db-track { stroke: #e5e7eb; }
      .db-loading-ring {
        opacity: 0;
        transform-box: fill-box;
        transform-origin: center;
        transform: rotate(-90deg);
      }
      .db-disc.db-spinning .db-loading-ring {
        opacity: 1;
        animation: db-spin .9s linear infinite;
      }
      .db-pct {
        position: absolute;
        font-size: 13px;
        font-weight: 600;
        color: #1f2937;
        pointer-events: none;
      }
      .db-abs {
        position: fixed;
        transform: translate(-50%, 0);
        font-size: 11px;
        font-weight: 600;
        color: #6b7280;
        pointer-events: none;
        z-index: 2147483001;
        font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
        text-shadow: 0 1px 2px rgba(255, 255, 255, .8);
      }
      .db-toast {
        position: fixed;
        transform: translateX(-50%);
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 5px 10px;
        border-radius: 6px;
        background: rgba(17, 24, 39, .9);
        color: #f9fafb;
        font-size: 11px;
        line-height: 1.4;
        white-space: normal;
        max-width: 260px;
        text-align: left;
        pointer-events: none;
        opacity: 0;
        transition: opacity .25s ease;
        z-index: 2147483003;
        font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
      }
      .db-toast.db-show { opacity: 1; }
      .db-spinner {
        display: none;
        width: 10px;
        height: 10px;
        border-radius: 50%;
        border: 2px solid rgba(255, 255, 255, .35);
        border-top-color: #fff;
        animation: db-toast-spin .8s linear infinite;
      }
      .db-toast.db-loading .db-spinner { display: inline-block; }
      @keyframes db-toast-spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }
      .db-panel {
        position: fixed;
        width: 248px;
        max-width: calc(100vw - 16px);
        max-height: calc(100vh - 16px);
        overflow-y: auto;
        padding: 12px 14px;
        border-radius: 10px;
        background: #fff;
        color: #111827;
        box-shadow: 0 8px 28px rgba(0, 0, 0, .18);
        border: 1px solid rgba(0, 0, 0, .06);
        font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
        font-size: 12px;
        line-height: 1.7;
        z-index: 2147483002;
        display: none;
      }
      .db-panel.db-open { display: block; }
      .db-row { display: flex; justify-content: space-between; gap: 16px; }
      .db-row .db-k { color: #6b7280; flex: none; }
      .db-row .db-v { font-variant-numeric: tabular-nums; text-align: right; }
      .db-total { font-size: 14px; font-weight: 600; margin-bottom: 4px; padding-right: 22px; }
      .db-sep { height: 1px; background: rgba(0, 0, 0, .06); margin: 8px 0; }
      .db-actions { display: flex; gap: 8px; margin-top: 10px; }
      .db-actions button {
        flex: 1;
        padding: 6px 8px;
        border-radius: 6px;
        border: 1px solid rgba(0, 0, 0, .1);
        background: #f9fafb;
        color: #374151;
        font-size: 12px;
        cursor: pointer;
      }
      .db-actions button:hover { background: #f3f4f6; }
      .db-icon {
        position: absolute;
        top: 6px;
        right: 6px;
        width: 22px;
        height: 22px;
        display: flex;
        align-items: center;
        justify-content: center;
        border: none;
        border-radius: 6px;
        background: transparent;
        color: #6b7280;
        font-size: 13px;
        line-height: 1;
        cursor: pointer;
      }
      .db-icon:hover { background: rgba(0, 0, 0, .06); color: #111827; }

      /* 居中的设置模态窗 */
      .db-settings-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(15, 23, 42, .3);
        z-index: 2147483005;
        display: none;
      }
      .db-settings-backdrop.db-open { display: block; }
      .db-settings-modal {
        position: fixed;
        left: 50%;
        top: 50%;
        transform: translate(-50%, -50%);
        width: 720px;
        max-width: calc(100vw - 32px);
        height: 440px;
        max-height: calc(100vh - 32px);
        display: none;
        background: #fff;
        color: #111827;
        border: 1px solid rgba(0, 0, 0, .08);
        border-radius: 12px;
        box-shadow: 0 24px 60px rgba(0, 0, 0, .24);
        overflow: hidden;
        z-index: 2147483006;
        font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
        font-size: 12px;
        flex-direction: row;
      }
      .db-settings-modal.db-open { display: flex; }
      .db-settings-closebar {
        position: relative;
        flex: none;
        height: 34px;
      }
      .db-settings-right {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
      }
      .db-settings-nav {
        width: 148px;
        flex: none;
        padding: 14px 10px;
        border-right: 1px solid rgba(0, 0, 0, .08);
        background: #f9fafb;
        display: flex;
        flex-direction: column;
        gap: 2px;
        overflow-y: auto;
      }
      .db-settings-nav-title {
        font-size: 12px;
        font-weight: 600;
        color: #6b7280;
        padding: 0 8px 8px;
      }
      .db-nav-item {
        text-align: left;
        padding: 7px 10px;
        border: none;
        border-radius: 6px;
        background: transparent;
        color: #374151;
        font-size: 12px;
        cursor: pointer;
      }
      .db-nav-item:hover { background: rgba(0, 0, 0, .05); }
      .db-nav-item.db-nav-active { background: #2563eb; color: #fff; }
      .db-settings-main {
        flex: 1;
        min-width: 0;
        padding: 16px 18px 0;
        overflow: hidden;
        display: flex;
        flex-direction: column;
      }
      .db-settings-pane {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
      }
      .db-settings-pane[data-pane="basic"] { padding-bottom: 16px; }
      .db-settings-pane[data-pane="cache"]:not([hidden]) {
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }
      .db-settings-pane[hidden] { display: none; }
      .db-pane-title {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        font-size: 13px;
        font-weight: 600;
        margin-bottom: 10px;
      }
      .db-settings-close {
        position: absolute;
        top: 6px;
        right: 8px;
        z-index: 2;
      }

      .db-field { margin-bottom: 8px; }
      .db-field label { display: block; font-size: 11px; color: #6b7280; margin-bottom: 3px; }
      .db-field select, .db-field input {
        width: 100%;
        height: 26px;
        padding: 4px 8px;
        border-radius: 6px;
        border: 1px solid rgba(0, 0, 0, .12);
        background: #fff;
        color: #111827;
        font-size: 12px;
      }
      .db-limit-custom { margin-top: 5px; }
      .db-msg { min-height: 14px; margin: 3px 0 0; font-size: 11px; color: #6b7280; }
      .db-msg.error { color: #dc2626; }
      .db-msg.ok { color: #16a34a; }

      .db-cache-list { max-height: 150px; overflow-y: auto; margin: 0 -4px; }
      .db-settings-pane .db-cache-list {
        flex: 1;
        min-height: 0;
        max-height: none;
      }
      .db-cache-row {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 2px 4px;
        border-radius: 5px;
      }
      .db-cache-row:hover { background: rgba(0, 0, 0, .04); }
      .db-cache-main { flex: 1; min-width: 0; line-height: 1.25; }
      .db-cache-title {
        font-size: 12px;
        line-height: 1.3;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .db-cache-sub {
        font-size: 10px;
        line-height: 1.3;
        color: #9ca3af;
        font-variant-numeric: tabular-nums;
      }
      .db-cache-del {
        flex: none;
        width: 20px;
        height: 20px;
        border: none;
        border-radius: 5px;
        background: transparent;
        color: #9ca3af;
        font-size: 13px;
        line-height: 1;
        cursor: pointer;
      }
      .db-cache-del:hover { background: rgba(220, 38, 38, .1); color: #dc2626; }
      .db-cache-empty { color: #9ca3af; font-size: 11px; padding: 6px 0; }

      .db-confirm {
        position: fixed;
        width: 360px;
        max-width: calc(100vw - 16px);
        max-height: calc(100vh - 16px);
        overflow-y: auto;
        border-radius: 10px;
        background: #fff;
        border: 1px solid rgba(0, 0, 0, .08);
        box-shadow: 0 12px 32px rgba(0, 0, 0, .2);
        font-size: 12px;
        line-height: 1.5;
        z-index: 2147483007;
        display: none;
      }
      .db-confirm.db-open { display: block; }
      .db-confirm-head {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        border-bottom: 1px solid rgba(0, 0, 0, .08);
        font-size: 12px;
        font-weight: 600;
        color: #111827;
      }
      .db-confirm-title { flex: none; }
      .db-confirm-target {
        flex: 1;
        min-width: 0;
        font-size: 10.5px;
        font-weight: 400;
        color: #6b7280;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .db-confirm-close {
        flex: none;
        border: none;
        background: transparent;
        color: #9ca3af;
        font-size: 14px;
        line-height: 1;
        padding: 0 2px;
        cursor: pointer;
      }
      .db-confirm-close:hover { color: #111827; }
      .db-confirm-body { padding: 8px 12px 9px; color: #6b7280; font-size: 11px; }
      .db-confirm-list {
        margin: 0;
        padding: 6px 8px 6px 18px;
        border-radius: 6px;
        background: rgba(220, 38, 38, .05);
        border-left: 2px solid rgba(220, 38, 38, .45);
        font-size: 10px;
        line-height: 1.5;
        color: #4b5563;
      }
      .db-confirm-list li { margin: 0 0 2px; }
      .db-confirm-list li:last-child { margin-bottom: 0; }
      .db-confirm-list li::marker { color: #dc2626; }
      .db-confirm-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        padding: 7px 12px;
        border-top: 1px solid rgba(0, 0, 0, .08);
      }
      .db-confirm-actions button {
        padding: 4px 10px;
        border-radius: 6px;
        border: 1px solid rgba(0, 0, 0, .12);
        background: #f9fafb;
        color: #374151;
        font-size: 11px;
        cursor: pointer;
      }
      .db-confirm-actions button:hover { background: #f3f4f6; }
      .db-confirm-actions .db-danger {
        color: #dc2626;
        border-color: rgba(220, 38, 38, .45);
        background: rgba(220, 38, 38, .06);
      }
      .db-confirm-actions .db-danger:hover { background: rgba(220, 38, 38, .12); }

      .db-theme-group { display: flex; gap: 8px; margin-top: 4px; }
      .db-theme-btn {
        flex: 1;
        padding: 7px 8px;
        border-radius: 6px;
        border: 1px solid rgba(0, 0, 0, .12);
        background: #f9fafb;
        color: #374151;
        font-size: 12px;
        cursor: pointer;
      }
      .db-theme-btn:hover { background: #f3f4f6; }
      .db-theme-btn.db-theme-active {
        border-color: #2563eb;
        background: rgba(37, 99, 235, .08);
        color: #2563eb;
        font-weight: 600;
      }

      /* 深色主题：由宿主属性控制，可手动切换 */
      :host([data-db-theme="dark"]) .db-disc {
        background: #0b0d10;
        box-shadow: 0 4px 18px rgba(0, 0, 0, .65);
      }
      :host([data-db-theme="dark"]) .db-pct { color: #ffffff; }
      :host([data-db-theme="dark"]) .db-abs { color: #d1d5db; text-shadow: none; }
      :host([data-db-theme="dark"]) .db-track { stroke: #2a2f38; }
      :host([data-db-theme="dark"]) .db-panel {
        background: #15181d;
        color: #f3f4f6;
        border-color: rgba(255, 255, 255, .08);
      }
      :host([data-db-theme="dark"]) .db-row .db-k,
      :host([data-db-theme="dark"]) .db-msg { color: #9ca3af; }
      :host([data-db-theme="dark"]) .db-sep { background: rgba(255, 255, 255, .08); }
      :host([data-db-theme="dark"]) .db-actions button {
        background: #242932;
        color: #e5e7eb;
        border-color: rgba(255, 255, 255, .12);
      }
      :host([data-db-theme="dark"]) .db-icon:hover {
        background: rgba(255, 255, 255, .1);
        color: #f3f4f6;
      }
      :host([data-db-theme="dark"]) .db-field select,
      :host([data-db-theme="dark"]) .db-field input {
        background: #111418;
        color: #f3f4f6;
        border-color: rgba(255, 255, 255, .15);
      }
      :host([data-db-theme="dark"]) .db-field label { color: #9ca3af; }
      :host([data-db-theme="dark"]) .db-theme-btn {
        background: #242932;
        color: #e5e7eb;
        border-color: rgba(255, 255, 255, .12);
      }
      :host([data-db-theme="dark"]) .db-theme-btn.db-theme-active {
        border-color: #60a5fa;
        background: rgba(96, 165, 250, .12);
        color: #93c5fd;
      }
      :host([data-db-theme="dark"]) .db-settings-modal {
        background: #15181d;
        color: #f3f4f6;
        border-color: rgba(255, 255, 255, .1);
      }
      :host([data-db-theme="dark"]) .db-settings-nav {
        background: #0f1216;
        border-right-color: rgba(255, 255, 255, .08);
      }
      :host([data-db-theme="dark"]) .db-settings-nav-title { color: #9ca3af; }
      :host([data-db-theme="dark"]) .db-nav-item { color: #cbd5e1; }
      :host([data-db-theme="dark"]) .db-nav-item:hover { background: rgba(255, 255, 255, .08); }
      :host([data-db-theme="dark"]) .db-nav-item.db-nav-active { background: #2563eb; color: #fff; }
      :host([data-db-theme="dark"]) .db-cache-row:hover { background: rgba(255, 255, 255, .06); }
      :host([data-db-theme="dark"]) .db-cache-title { color: #e5e7eb; }
      :host([data-db-theme="dark"]) .db-confirm {
        background: #15181d;
        border-color: rgba(255, 255, 255, .1);
      }
      :host([data-db-theme="dark"]) .db-confirm-head {
        color: #f3f4f6;
        border-bottom-color: rgba(255, 255, 255, .1);
      }
      :host([data-db-theme="dark"]) .db-confirm-body { color: #9ca3af; }
      :host([data-db-theme="dark"]) .db-confirm-target { color: #9ca3af; }
      :host([data-db-theme="dark"]) .db-confirm-list {
        background: rgba(248, 113, 113, .08);
        border-left-color: rgba(248, 113, 113, .5);
        color: #cbd5e1;
      }
      :host([data-db-theme="dark"]) .db-confirm-list li::marker { color: #f87171; }
      :host([data-db-theme="dark"]) .db-confirm-actions { border-top-color: rgba(255, 255, 255, .1); }
      :host([data-db-theme="dark"]) .db-confirm-actions button {
        background: #242932;
        color: #e5e7eb;
        border-color: rgba(255, 255, 255, .12);
      }
      :host([data-db-theme="dark"]) .db-confirm-close:hover { color: #f3f4f6; }
      :host([data-db-theme="dark"]) .db-confirm-actions .db-danger {
        color: #f87171;
        border-color: rgba(248, 113, 113, .45);
        background: rgba(248, 113, 113, .08);
      }
    </style>

    <div class="db-disc" part="disc">
      <svg width="56" height="56" viewBox="0 0 56 56">
        <circle class="db-track" cx="28" cy="28" r="23" fill="none" stroke-width="6"></circle>
        <circle class="db-ring" cx="28" cy="28" r="23" fill="none" stroke="#22c55e"
                stroke-width="6" stroke-linecap="round"></circle>
        <circle class="db-loading-ring" cx="28" cy="28" r="23" fill="none" stroke="#9ca3af"
                stroke-width="6" stroke-linecap="round" stroke-dasharray="36 108.5"></circle>
      </svg>
      <span class="db-pct">—</span>
    </div>
    <div class="db-abs">—</div>
    <div class="db-toast"><span class="db-spinner"></span><span class="db-toast-text"></span></div>

    <div class="db-panel">
      <button class="db-icon" data-action="open-settings" title="设置">⚙</button>
      <div class="db-total"><span class="db-total-text">—</span></div>
      <div class="db-row"><span class="db-k">本轮</span><span class="db-v db-round">—</span></div>
      <div class="db-row"><span class="db-k">附件</span><span class="db-v db-attach">—</span></div>
      <div class="db-row"><span class="db-k">剩余</span><span class="db-v db-left">—</span></div>
      <div class="db-sep"></div>
      <div class="db-row"><span class="db-k">数据</span><span class="db-v db-source">—</span></div>
      <div class="db-row"><span class="db-k">更新</span><span class="db-v db-time">—</span></div>
      <div class="db-actions">
        <button data-action="refresh">重新拉取历史</button>
      </div>
    </div>

    <div class="db-settings-backdrop"></div>
    <div class="db-settings-modal">
      <aside class="db-settings-nav">
        <div class="db-settings-nav-title">设置</div>
        <button class="db-nav-item db-nav-active" data-settings-tab="basic">基础</button>
        <button class="db-nav-item" data-settings-tab="cache">会话缓存</button>
        <button class="db-nav-item" data-settings-tab="appearance">外观</button>
      </aside>

      <div class="db-settings-right">
        <div class="db-settings-closebar">
          <button class="db-icon db-settings-close" data-action="close-settings" title="关闭">×</button>
        </div>

        <main class="db-settings-main">
          <section class="db-settings-pane" data-pane="basic">
            <div class="db-pane-title">基础</div>
            <div class="db-field">
              <label for="db-limit-select">上下文上限</label>
              <select id="db-limit-select" class="db-limit-select">
                <option value="1000000">1,000,000（1M，默认）</option>
                <option value="128000">128,000（128K）</option>
                <option value="64000">64,000（64K）</option>
                <option value="custom">自定义…</option>
              </select>
              <input class="db-limit-custom" type="number" min="1000" max="10000000" step="1000"
                     placeholder="1000 – 10,000,000" hidden>
              <p class="db-msg db-limit-msg"></p>
            </div>
          </section>

          <section class="db-settings-pane" data-pane="cache" hidden>
            <div class="db-pane-title">
              <span>会话缓存</span>
              <span class="db-cache-count">—</span>
            </div>
            <div class="db-cache-list"></div>
          </section>

          <section class="db-settings-pane" data-pane="appearance" hidden>
            <div class="db-pane-title">外观</div>
            <div class="db-field">
              <label>主题</label>
              <div class="db-theme-group">
                <button class="db-theme-btn" data-theme-choice="dark">深色模式</button>
                <button class="db-theme-btn" data-theme-choice="light">浅色模式</button>
                <button class="db-theme-btn" data-theme-choice="auto">跟随网页</button>
              </div>
              <p class="db-msg db-theme-msg"></p>
            </div>
          </section>
        </main>
      </div>
    </div>

    <div class="db-confirm">
      <div class="db-confirm-head">
        <span class="db-confirm-title">删除会话缓存</span>
        <span class="db-confirm-target">—</span>
        <button class="db-confirm-close" data-action="confirm-cancel" title="取消">×</button>
      </div>
      <div class="db-confirm-body">
        <ul class="db-confirm-list">
          <li>本机累计值会被清空</li>
          <li>下次进入需重新拉取完整历史（长对话约十几秒）</li>
          <li>操作不可撤销；服务端对话数据不受影响</li>
        </ul>
      </div>
      <div class="db-confirm-actions">
        <button data-action="confirm-cancel">取消</button>
        <button data-action="confirm-delete" class="db-danger">删除</button>
      </div>
    </div>
  `
}

/* ---------------- 事件 ---------------- */

function bindEvents() {
  let startX = 0
  let startY = 0
  let originLeft = 0
  let originTop = 0
  let moved = false

  disc.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    const rect = disc.getBoundingClientRect()
    startX = e.clientX
    startY = e.clientY
    originLeft = rect.left
    originTop = rect.top
    moved = false
    dragging = true
    disc.setPointerCapture(e.pointerId)
  })

  disc.addEventListener('pointermove', (e) => {
    if (!dragging) return
    const dx = e.clientX - startX
    const dy = e.clientY - startY
    if (!moved && Math.hypot(dx, dy) > 5) moved = true
    if (!moved) return

    const left = clamp(originLeft + dx, 0, window.innerWidth - 56)
    const top = clamp(originTop + dy, 0, window.innerHeight - 56)
    setDiscPosition(left, top)
    positionAbs()
    if (panel.classList.contains('db-open')) positionPanel()
    positionConfirm()
  })

  disc.addEventListener('pointerup', (e) => {
    if (!dragging) return
    dragging = false
    try {
      disc.releasePointerCapture(e.pointerId)
    } catch {
      // 指针已释放
    }

    if (moved) {
      clampDiscPosition()
      savePosition()
    } else {
      calibrateCache()
    }
  })

  disc.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    togglePanel()
  })

  shadow.addEventListener('click', (e) => {
    const actionEl = e.target.closest && e.target.closest('[data-action]')
    if (actionEl) {
      handleAction(actionEl.dataset.action)
      return
    }

    const removeEl = e.target.closest && e.target.closest('[data-remove-session]')
    if (removeEl) {
      removeSessionCache(removeEl.dataset.removeSession, removeEl.dataset.removeTitle)
      return
    }

    if (
      panel.classList.contains('db-open') &&
      !e.target.closest('.db-panel') &&
      !e.target.closest('.db-disc') &&
      !e.target.closest('.db-confirm')
    ) {
      togglePanel(false)
    }
  })

  shadow.querySelector('.db-limit-select').addEventListener('change', (e) => {
    const value = e.target.value
    const customInput = shadow.querySelector('.db-limit-custom')

    if (value === 'custom') {
      customInput.hidden = false
      customInput.focus()
      if (!customInput.value) customInput.value = String(state.limit)
      return
    }

    customInput.hidden = true
    showLimitMsg('')
    saveLimit(Number(value))
  })

  const customInput = shadow.querySelector('.db-limit-custom')

  // 输入过程只保留数字、不校验；确认时（回车 / 失焦 / change）才校验
  customInput.addEventListener('input', () => {
    const digits = customInput.value.replace(/[^\d]/g, '')
    if (digits !== customInput.value) customInput.value = digits
    showLimitMsg('')
  })

  customInput.addEventListener('change', commitCustomLimit)
  customInput.addEventListener('blur', commitCustomLimit)
  customInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commitCustomLimit()
  })

  shadow.querySelectorAll('.db-nav-item').forEach((btn) => {
    btn.addEventListener('click', () => switchSettingsTab(btn.dataset.settingsTab))
  })

  shadow.querySelectorAll('.db-theme-btn').forEach((btn) => {
    btn.addEventListener('click', () => saveTheme(btn.dataset.themeChoice))
  })

  settingsBackdrop.addEventListener('click', closeSettings)

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    if (settingsModal.classList.contains('db-open')) {
      closeSettings()
      return
    }
    if (confirmEl.classList.contains('db-open')) {
      cancelDelete()
      return
    }
    togglePanel(false)
  })

  // 点页面其它地方收起面板（composedPath 能同时兼容 Shadow DOM）
  document.addEventListener(
    'click',
    (e) => {
      if (!e.composedPath().includes(host)) togglePanel(false)
    },
    true
  )

  window.addEventListener('message', (event) => {
    if (event.source !== window) return
    if (!event.data || event.data.source !== 'deepbrim') return
    handleData(event.data)
  })

  window.addEventListener('resize', () => {
    clampDiscPosition()
    if (panel.classList.contains('db-open')) positionPanel()
    positionAbs()
    positionConfirm()
  })

  // 页面关闭前把未落盘的缓存写完
  window.addEventListener('pagehide', () => {
    clearTimeout(cacheTimer)
    writeCache()
  })

  // 上限被改动后立即生效
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return

      if (changes[LIMIT_KEY]) {
        const limit = changes[LIMIT_KEY].newValue
        if (typeof limit === 'number' && limit > 0) {
          state.limit = limit
          syncLimitSelect()
          render()
        }
      }

      if (changes[THEME_KEY]) {
        themeChoice = normalizeTheme(changes[THEME_KEY].newValue)
        applyTheme()
        syncThemeButtons()
      }
    })
  } catch {
    // 无扩展上下文时忽略
  }
}

let spinTimer = null

function handleAction(action) {
  if (action === 'refresh') requestHardRefresh()
  if (action === 'open-settings') openSettings()
  if (action === 'close-settings') closeSettings()
  if (action === 'confirm-cancel') cancelDelete()
  if (action === 'confirm-delete') confirmDelete()
}

function openSettings() {
  if (panel.classList.contains('db-open')) togglePanel(false)

  cancelDelete()
  syncLimitSelect()
  syncThemeButtons()
  settingsModal.classList.add('db-open')
  settingsBackdrop.classList.add('db-open')
  switchSettingsTab(settingsTab)
}

function closeSettings() {
  cancelDelete()
  settingsModal.classList.remove('db-open')
  settingsBackdrop.classList.remove('db-open')
}

function switchSettingsTab(tab) {
  settingsTab = tab

  shadow.querySelectorAll('.db-settings-pane').forEach((pane) => {
    pane.hidden = pane.dataset.pane !== tab
  })
  shadow.querySelectorAll('.db-nav-item').forEach((btn) => {
    btn.classList.toggle('db-nav-active', btn.dataset.settingsTab === tab)
  })

  if (tab === 'cache') loadCacheList()
}

function calibrateCache() {
  if (pendingHardRefresh) {
    showToast('正在拉取历史，请稍候…')
    return
  }

  spinOnce()
  if (!state.sessionId) {
    setTimeout(() => showToast('暂无会话数据'), 700)
    return
  }
  flushCache()
  // 等转圈动画走完再闪现提示
  setTimeout(() => showToast('✓ 本地缓存已校准'), 700)
}

function requestHardRefresh() {
  if (!state.sessionId) {
    showToast('暂无会话数据')
    return
  }

  state.roundTokens = null
  state.roundSource = null
  state.officialPrevTotal = null
  render()

  pendingHardRefresh = true
  startSpin()
  showToast('正在同步历史…', { loading: true, timeout: 0 })

  // 超过 1.5 秒仍未返回，说明在拉全量，换成更明确的等待提示
  clearTimeout(pendingSlowTimer)
  pendingSlowTimer = setTimeout(() => {
    if (!pendingHardRefresh) return
    showToast('正在拉取完整历史，长对话可能需要十几秒，请稍候…', { loading: true, timeout: 0 })
  }, 1500)

  clearTimeout(pendingTimer)
  pendingTimer = setTimeout(() => {
    if (!pendingHardRefresh) return
    pendingHardRefresh = false
    stopSpin()
    showToast('请求超时，已保留缓存')
  }, 30000)

  window.postMessage(
    {
      source: 'deepbrim-ui',
      type: 'hard-refresh',
      sessionId: state.sessionId,
      hasCache: (state.officialTotal ?? state.baselineValue) != null
    },
    '*'
  )
}

// 持续转圈：请求进行中一直转
function startSpin() {
  clearTimeout(spinTimer)
  disc.classList.remove('db-spin-once')
  disc.classList.add('db-spinning')
}

function stopSpin() {
  disc.classList.remove('db-spinning')
  clearTimeout(pendingSlowTimer)
}

// 短转一圈：左键本地校准用；请求进行中不打断
function spinOnce() {
  if (disc.classList.contains('db-spinning')) return
  disc.classList.remove('db-spin-once')
  void disc.offsetWidth
  disc.classList.add('db-spin-once')
  clearTimeout(spinTimer)
  spinTimer = setTimeout(() => disc.classList.remove('db-spin-once'), 700)
}

function showToast(text, options = {}) {
  const { loading = false, timeout = 1500 } = options
  const rect = disc.getBoundingClientRect()
  let top = rect.top - 28

  if (top < 8) {
    // 上方放不下：面板开着就落到面板下方，否则落到圆盘下方
    if (panel.classList.contains('db-open')) {
      const panelRect = panel.getBoundingClientRect()
      top = Math.min(window.innerHeight - 30, panelRect.bottom + 6)
    } else {
      top = rect.bottom + 8
    }
  }

  toastEl.querySelector('.db-toast-text').textContent = text
  toastEl.classList.toggle('db-loading', loading)
  toastEl.style.left = `${rect.left + rect.width / 2}px`
  toastEl.style.top = `${top}px`
  toastEl.classList.add('db-show')

  clearTimeout(toastTimer)
  if (timeout > 0) toastTimer = setTimeout(() => toastEl.classList.remove('db-show'), timeout)
}

/* ---------------- 数据 ---------------- */

function handleData(msg) {
  const { type, payload } = msg
  if (!payload) return

  const incoming = payload.sessionId && payload.sessionId !== 'unknown' ? payload.sessionId : null
  if (incoming) {
    // 当前没有会话（例如新对话首条消息）时才接管；其他会话的后台数据直接丢弃，
    // 避免旧会话的流式结果或落库校准把界面切回去
    if (!state.sessionId) switchSession(incoming)
    else if (incoming !== state.sessionId) return
  }

  if (type === 'history-baseline') {
    // 拉取失败时不覆盖现有数据显示，只给提示
    if (payload.ok === false) {
      if (pendingHardRefresh && payload.source !== 'page') {
        pendingHardRefresh = false
        clearTimeout(pendingTimer)
        stopSpin()
        showToast('历史拉取失败，已保留缓存')
      }
      return
    }

    const baseline = typeof payload.baseline === 'number' && payload.baseline > 0 ? payload.baseline : null
    state.baselineValue = baseline
    state.baselineSource = baseline != null ? payload.baselineSource ?? null : null
    state.messageCount = payload.messageCount ?? state.messageCount
    // 历史响应里的会话标题比 document.title 更准
    if (payload.title) state.title = payload.title
    if (payload.baselineSource === 'message-field' && baseline != null) {
      if (state.officialTotal != null && state.officialTotal !== baseline) {
        console.log(TAG, `🗂 历史校准总量 ${state.officialTotal} → ${baseline}`)
      }
      state.officialTotal = baseline
    }
    state.updatedAt = Date.now()
    state.fromCache = false
    saveCache()

    if (pendingHardRefresh && payload.source !== 'page') {
      pendingHardRefresh = false
      clearTimeout(pendingTimer)
      stopSpin()
      showToast('✓ 历史已重新拉取')
    }
  }

  if (type === 'sync-status') {
    if (pendingHardRefresh && (payload.status === 'up-to-date' || payload.status === 'no-session' || payload.status === 'empty')) {
      pendingHardRefresh = false
      clearTimeout(pendingTimer)
      stopSpin()
      if (payload.status === 'up-to-date') showToast('✓ 已是最新（无需重建）')
      else if (payload.status === 'no-session') showToast('新对话暂无历史，发送消息后自动统计')
      else showToast('该会话暂无历史数据')
    }
    return
  }

  if (type === 'usage') {
    if (payload.total != null && payload.total > 0) {
      state.officialTotal = payload.total
      state.updatedAt = Date.now()
      state.fromCache = false
      saveCache()
    }
  }

  if (type === 'stream-end') {
    if (payload.total != null && payload.total > 0) state.officialTotal = payload.total
    state.attachmentTokens = payload.attachmentTokens ?? state.attachmentTokens
    state.updatedAt = Date.now()
    state.fromCache = false
    saveCache()
  }

  if (type === 'post-turn') {
    if (payload.total != null) state.officialTotal = payload.total
    if (payload.roundTokens != null && payload.total != null) {
      state.roundTokens = payload.roundTokens
      state.roundSource = payload.roundSource
      state.officialPrevTotal = payload.total - payload.roundTokens
    }
    state.updatedAt = Date.now()
    state.fromCache = false
    saveCache()
  }

  if (type === 'file-usage') {
    state.attachmentTokens = (state.attachmentTokens || 0) + (payload.tokens || 0)
    state.updatedAt = Date.now()
    saveCache()
  }

  render()
}

/* ---------------- 缓存 ---------------- */

function switchSession(sessionId) {
  if (!sessionId || sessionId === state.sessionId) return

  flushCache()
  state.sessionId = sessionId
  resetSessionData()

  const token = ++cacheLoadToken
  render()

  try {
    chrome.storage.local.get(CACHE_PREFIX + sessionId, (res) => {
      if (token !== cacheLoadToken) return
      if (state.officialTotal != null || state.baselineValue != null) return

      const rec = res && res[CACHE_PREFIX + sessionId]
      if (!rec) return
      applyRecord(rec)
      render()
    })
  } catch {
    // 无扩展上下文时忽略
  }
}

function applyRecord(rec) {
  state.officialTotal = rec.officialTotal ?? null
  state.officialPrevTotal = rec.officialPrevTotal ?? null
  state.baselineValue = rec.baselineValue ?? null
  state.baselineSource = rec.baselineSource ?? null
  state.attachmentTokens = rec.attachmentTokens ?? null
  state.messageCount = rec.messageCount ?? null
  state.updatedAt = rec.updatedAt ?? null
  state.title = rec.title ?? null
  state.fromCache = true
}

function resetSessionData() {
  state.officialTotal = null
  state.officialPrevTotal = null
  state.baselineValue = null
  state.baselineSource = null
  state.roundTokens = null
  state.roundSource = null
  state.attachmentTokens = null
  state.messageCount = null
  state.updatedAt = null
  state.fromCache = false
  state.title = null
}

function saveCache() {
  if (!state.sessionId) return
  clearTimeout(cacheTimer)
  cacheTimer = setTimeout(writeCache, CACHE_DEBOUNCE)
}

function flushCache() {
  clearTimeout(cacheTimer)
  writeCache()
}

function writeCache() {
  if (!state.sessionId) return
  if (state.officialTotal == null && state.baselineValue == null) return

  const key = CACHE_PREFIX + state.sessionId
  const record = {
    title: resolveTitleForCache(),
    officialTotal: state.officialTotal,
    officialPrevTotal: state.officialPrevTotal,
    baselineValue: state.baselineValue,
    baselineSource: state.baselineSource,
    attachmentTokens: state.attachmentTokens,
    messageCount: state.messageCount,
    updatedAt: state.updatedAt || Date.now()
  }

  try {
    chrome.storage.local.set({ [key]: record })
  } catch {
    // 无扩展上下文时忽略
  }
}

function loadCacheList() {
  const listEl = shadow.querySelector('.db-cache-list')
  const countEl = shadow.querySelector('.db-cache-count')
  listEl.textContent = ''

  try {
    chrome.storage.local.get(null, (all) => {
      const entries = Object.keys(all || {})
        .filter((key) => key.startsWith(CACHE_PREFIX))
        .map((key) => ({ id: key.slice(CACHE_PREFIX.length), rec: all[key] }))
        .sort((a, b) => (b.rec.updatedAt || 0) - (a.rec.updatedAt || 0))

      countEl.textContent = entries.length ? `${entries.length} 个` : '暂无'

      if (!entries.length) {
        const empty = document.createElement('div')
        empty.className = 'db-cache-empty'
        empty.textContent = '还没有缓存记录'
        listEl.appendChild(empty)
        return
      }

      for (const entry of entries) listEl.appendChild(cacheRow(entry.id, entry.rec))
    })
  } catch {
    countEl.textContent = '不可用'
  }
}

function cacheRow(id, rec) {
  const row = document.createElement('div')
  row.className = 'db-cache-row'

  const main = document.createElement('div')
  main.className = 'db-cache-main'

  const title = document.createElement('div')
  title.className = 'db-cache-title'
  title.textContent = rec.title || `会话 ${id.slice(0, 8)}`

  const sub = document.createElement('div')
  sub.className = 'db-cache-sub'
  const total = rec.officialTotal ?? rec.baselineValue
  const time = rec.updatedAt
    ? new Date(rec.updatedAt).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      })
    : '—'
  sub.textContent = `${formatTokens(total)} · ${time}`

  main.appendChild(title)
  main.appendChild(sub)

  const del = document.createElement('button')
  del.className = 'db-cache-del'
  del.dataset.removeSession = id
  del.dataset.removeTitle = rec.title || `会话 ${id.slice(0, 8)}`
  del.title = '删除这条缓存'
  del.textContent = '×'

  row.appendChild(main)
  row.appendChild(del)
  return row
}

function removeSessionCache(id, label) {
  pendingDeleteId = id
  confirmEl.querySelector('.db-confirm-target').textContent = `「${label || id.slice(0, 8)}」`
  confirmEl.classList.add('db-open')
  positionConfirm()
}

function cancelDelete() {
  pendingDeleteId = null
  confirmEl.classList.remove('db-open')
}

function confirmDelete() {
  const id = pendingDeleteId
  if (!id) {
    cancelDelete()
    return
  }

  pendingDeleteId = null
  confirmEl.classList.remove('db-open')

  try {
    chrome.storage.local.remove(CACHE_PREFIX + id, () => {
      if (state.sessionId === id) state.fromCache = false
      loadCacheList()
      showToast('✓ 已删除该会话缓存')
    })
  } catch {
    // 无扩展上下文时忽略
  }
}

/* ---------------- 设置 ---------------- */

function syncLimitSelect() {
  const select = shadow.querySelector('.db-limit-select')
  const customInput = shadow.querySelector('.db-limit-custom')
  if (!select) return

  if (PRESETS.includes(state.limit)) {
    select.value = String(state.limit)
    customInput.hidden = true
  } else {
    select.value = 'custom'
    customInput.hidden = false
    customInput.value = String(state.limit)
  }
}

function commitCustomLimit() {
  const customInput = shadow.querySelector('.db-limit-custom')
  const value = Number(customInput.value)

  if (!isValidLimit(value)) {
    showLimitMsg(`范围 ${LIMIT_MIN.toLocaleString()} – ${LIMIT_MAX.toLocaleString()} tokens`, 'error')
    customInput.value = String(state.limit)
    return
  }

  saveLimit(value)
}

function saveLimit(value) {
  if (!isValidLimit(value)) {
    showLimitMsg(`范围 ${LIMIT_MIN.toLocaleString()} – ${LIMIT_MAX.toLocaleString()} tokens`, 'error')
    return
  }

  try {
    chrome.storage.local.set({ [LIMIT_KEY]: value }, () => {
      state.limit = value
      syncLimitSelect()
      render()
      showLimitMsg(`已保存：${value.toLocaleString()} tokens`, 'ok')
    })
  } catch {
    // 无扩展上下文时忽略
  }
}

function isValidLimit(value) {
  return Number.isInteger(value) && value >= LIMIT_MIN && value <= LIMIT_MAX
}

function showLimitMsg(text, kind) {
  const msg = shadow.querySelector('.db-limit-msg')
  if (!msg) return
  msg.textContent = text
  msg.className = `db-msg db-limit-msg${kind ? ` ${kind}` : ''}`
}

/* ---------------- 主题 ---------------- */

function normalizeTheme(value) {
  return value === 'dark' || value === 'light' ? value : 'auto'
}

function initTheme() {
  try {
    chrome.storage.local.get(THEME_KEY, (res) => {
      themeChoice = normalizeTheme(res && res[THEME_KEY])
      applyTheme()
      syncThemeButtons()
    })
  } catch {
    applyTheme()
    syncThemeButtons()
  }

  watchPageTheme()

  // 页面 hydration 后主题可能才落定，补两次校准
  setTimeout(applyTheme, 0)
  setTimeout(applyTheme, 1200)
}

function saveTheme(choice) {
  themeChoice = normalizeTheme(choice)
  applyTheme()
  syncThemeButtons()

  try {
    chrome.storage.local.set({ [THEME_KEY]: themeChoice })
  } catch {
    // 无扩展上下文时忽略
  }
}

function syncThemeButtons() {
  shadow.querySelectorAll('.db-theme-btn').forEach((btn) => {
    btn.classList.toggle('db-theme-active', btn.dataset.themeChoice === themeChoice)
  })
}

function applyTheme() {
  const next = resolveTheme()
  if (host.getAttribute('data-db-theme') === next) return

  host.setAttribute('data-db-theme', next)
  console.log(TAG, `🎨 主题切换为 ${next}${themeChoice === 'auto' ? '（跟随网页）' : '（手动）'}`)
}

function resolveTheme() {
  if (themeChoice === 'dark' || themeChoice === 'light') return themeChoice
  return detectPageTheme()
}

function detectPageTheme() {
  const root = document.documentElement
  if (!root) return 'light'

  const rootStyle = getComputedStyle(root)
  const body = document.body
  const bodyStyle = body ? getComputedStyle(body) : null

  // 1) 显式标记：class / data-theme / data-color-mode
  const explicit = explicitTheme(root) || (body ? explicitTheme(body) : null)
  if (explicit) return explicit

  // 2) color-scheme
  const colorScheme = `${rootStyle.colorScheme || ''} ${bodyStyle ? bodyStyle.colorScheme : ''}`
  if (colorScheme.includes('dark') && !colorScheme.includes('light')) return 'dark'
  if (colorScheme.includes('light') && !colorScheme.includes('dark')) return 'light'

  // 3) 背景亮度（透明则看 html 或文字颜色）
  const rootBg = colorLuminance(rootStyle.backgroundColor)
  if (rootBg != null) return rootBg < 0.45 ? 'dark' : 'light'

  if (bodyStyle) {
    const bodyBg = colorLuminance(bodyStyle.backgroundColor)
    if (bodyBg != null) return bodyBg < 0.45 ? 'dark' : 'light'

    // 4) 文字亮度：深色主题通常配浅色文字
    const textLum = colorLuminance(bodyStyle.color)
    if (textLum != null) return textLum > 0.6 ? 'dark' : 'light'
  }

  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function explicitTheme(el) {
  const cls = el.classList
  const theme = el.getAttribute('data-theme') || el.getAttribute('data-color-mode')

  if (theme === 'dark' || cls.contains('dark') || cls.contains('dark-theme')) return 'dark'
  if (theme === 'light' || cls.contains('light') || cls.contains('light-theme')) return 'light'
  return null
}

// 返回亮度 0–1，透明或无法解析时返回 null
function colorLuminance(color) {
  if (!color) return null

  const match = color.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/)
  if (!match) return null

  const alpha = match[4] !== undefined ? Number(match[4]) : 1
  if (alpha === 0) return null

  return (Number(match[1]) * 0.299 + Number(match[2]) * 0.587 + Number(match[3]) * 0.114) / 255
}

function watchPageTheme() {
  const reapply = () => {
    if (themeChoice === 'auto') applyTheme()
  }

  try {
    themeObserver = new MutationObserver(reapply)
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme', 'data-color-mode', 'style']
    })
  } catch {
    // 观察失败时依赖下面的轮询
  }

  attachBodyThemeObserver()
  document.addEventListener('DOMContentLoaded', attachBodyThemeObserver, { once: true })

  try {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', reapply)
  } catch {
    // 旧浏览器忽略
  }

  // 网页换肤可能只改 CSS 变量，不触发属性变化，用低频轮询兜底
  setInterval(() => {
    if (themeChoice !== 'auto') return
    attachBodyThemeObserver()
    const next = detectPageTheme()
    if (host.getAttribute('data-db-theme') !== next) {
      host.setAttribute('data-db-theme', next)
    }
  }, 600)
}

// 主题实际挂在 body 的 class 上（如 "zh_CN light"），必须等 body 出现后再观察
function attachBodyThemeObserver() {
  if (bodyThemeObserved || !themeObserver || !document.body) return

  bodyThemeObserved = true
  themeObserver.observe(document.body, {
    attributes: true,
    attributeFilter: ['class', 'data-theme', 'data-color-mode', 'style']
  })
}

/* ---------------- 会话识别 ---------------- */

function getSessionIdFromLocation() {
  const match = location.pathname.match(/\/chat\/s\/([0-9a-f-]{36})/i)
  if (match) return match[1]
  try {
    return new URLSearchParams(location.search).get('chat_session_id') || null
  } catch {
    return null
  }
}

function startUrlPolling() {
  setInterval(() => {
    const id = getSessionIdFromLocation()
    if (id) {
      switchSession(id)
      syncTitle(id)
    } else if (state.sessionId) {
      leaveSession()
    }
  }, URL_POLL_MS)
}

// 用户重命名对话后，页面标题会变，这里跟着刷新缓存里的标题
function syncTitle(currentId) {
  if (!currentId || currentId !== state.sessionId) return

  const title = getSessionTitle()
  if (!title || title === state.title) return

  state.title = title
  saveCache()
  if (settingsModal.classList.contains('db-open')) loadCacheList()
}

// 写缓存时只在页面仍停留在该会话时读标题，避免把新会话标题写到旧会话
function resolveTitleForCache() {
  if (getSessionIdFromLocation() === state.sessionId) {
    const title = getSessionTitle()
    if (title) return title
  }
  return state.title || null
}

function leaveSession() {
  flushCache()
  state.sessionId = null
  resetSessionData()
  render()
}

function getSessionTitle() {
  const raw = document.title || ''
  if (!raw || raw.includes('探索未至之境')) return null
  const cleaned = raw.replace(/\s*[-|·]\s*DeepSeek.*$/i, '').trim()
  return cleaned && cleaned.toLowerCase() !== 'deepseek' ? cleaned : null
}

/* ---------------- 渲染 ---------------- */

function render() {
  const total = state.officialTotal ?? state.baselineValue
  const percent = total != null && state.limit ? Math.min(100, (total / state.limit) * 100) : 0
  const circumference = 2 * Math.PI * 23

  if (total == null) {
    // 空态：按 0.1% 的长度画灰弧（配合圆头线帽会呈现为一个 12 点方向的小圆点）
    const stub = circumference * 0.001
    ring.setAttribute('stroke', '#9ca3af')
    ring.setAttribute('stroke-dasharray', `${stub} ${circumference - stub}`)
    ring.setAttribute('stroke-dashoffset', '0')
  } else {
    ring.setAttribute('stroke', colorFor(percent))
    ring.setAttribute('stroke-dasharray', String(circumference))
    ring.setAttribute('stroke-dashoffset', String(circumference * (1 - percent / 100)))
  }

  pctEl.textContent = total == null ? '—' : formatPercent(percent)
  absEl.textContent = total == null ? '—' : formatTokens(total)
  positionAbs()

  const round = resolveRound()
  shadow.querySelector('.db-total-text').textContent =
    total == null ? '—' : `${formatTokens(total)} / ${formatTokens(state.limit)} (${formatPercent(percent)})`
  shadow.querySelector('.db-round').textContent =
    round.value == null ? '—' : `${round.source === 'estimate' ? '~' : ''}${formatTokens(round.value)}`
  shadow.querySelector('.db-attach').textContent =
    state.attachmentTokens == null ? '—' : formatTokens(state.attachmentTokens)
  shadow.querySelector('.db-left').textContent =
    total == null ? '—' : formatTokens(Math.max(0, state.limit - total))
  shadow.querySelector('.db-source').textContent = sourceLabel()
  shadow.querySelector('.db-time').textContent =
    state.updatedAt == null ? '—' : new Date(state.updatedAt).toLocaleTimeString('zh-CN', { hour12: false })
}

function resolveRound() {
  if (state.roundTokens != null) return { value: state.roundTokens, source: state.roundSource }
  if (state.officialTotal != null && state.officialPrevTotal != null) {
    return { value: state.officialTotal - state.officialPrevTotal, source: 'completion' }
  }
  return { value: null, source: null }
}

function sourceLabel() {
  let base = '等待数据'
  if (state.officialTotal != null) base = '官方真值'
  else if (state.baselineValue != null) base = state.baselineSource === 'estimate' ? '历史估算' : '历史数据'

  return state.fromCache ? `缓存 · ${base}` : base
}

/* ---------------- 位置 ---------------- */

function setDiscPosition(left, top) {
  disc.style.left = `${left}px`
  disc.style.top = `${top}px`
  disc.style.transform = 'none'
}

// 圆盘始终留在视口内：窗口缩放、恢复位置、拖拽结束时都校正一次
function clampDiscPosition() {
  const rect = disc.getBoundingClientRect()
  const size = rect.width || 56
  const maxLeft = Math.max(0, window.innerWidth - size)
  const maxTop = Math.max(0, window.innerHeight - size)

  const left = clamp(rect.left, 0, maxLeft)
  const top = clamp(rect.top, 0, maxTop)

  if (left !== rect.left || top !== rect.top) {
    setDiscPosition(left, top)
  }
  positionAbs()
}

function positionAbs() {
  const rect = disc.getBoundingClientRect()
  absEl.style.left = `${rect.left + rect.width / 2}px`
  absEl.style.top = `${rect.bottom + 4}px`
}

function positionPanel() {
  const rect = disc.getBoundingClientRect()
  const panelRect = panel.getBoundingClientRect()
  const gap = 10
  const margin = 8

  let left = rect.left + rect.width / 2 - panelRect.width / 2
  left = clamp(left, margin, Math.max(margin, window.innerWidth - panelRect.width - margin))
  panel.style.left = `${left}px`

  // 优先上方，其次下方，都放不下就贴边，保证始终在视口内
  const maxTop = Math.max(margin, window.innerHeight - panelRect.height - margin)
  const aboveTop = rect.top - panelRect.height - gap
  const belowTop = rect.bottom + gap

  let top
  if (aboveTop >= margin) top = aboveTop
  else if (belowTop <= maxTop) top = belowTop
  else top = clamp(belowTop, margin, maxTop)

  panel.style.bottom = 'auto'
  panel.style.top = `${top}px`
}

// 只做纵向纠偏：内容变高后若底部溢出，就把面板整体上移，不改变左右与上下方位
function ensurePanelInView() {
  if (!panel.classList.contains('db-open')) return

  const rect = panel.getBoundingClientRect()
  const margin = 8
  let top = rect.top

  if (rect.bottom > window.innerHeight - margin) {
    top -= rect.bottom - (window.innerHeight - margin)
  }
  if (top < margin) top = margin

  panel.style.bottom = 'auto'
  panel.style.top = `${top}px`
}

function positionConfirm() {
  if (!confirmEl || !confirmEl.classList.contains('db-open')) return

  const cRect = confirmEl.getBoundingClientRect()

  // 设置模态窗打开时，确认卡居中显示
  if (settingsModal.classList.contains('db-open')) {
    confirmEl.style.left = `${Math.max(8, (window.innerWidth - cRect.width) / 2)}px`
    confirmEl.style.top = `${Math.max(8, (window.innerHeight - cRect.height) / 2)}px`
    return
  }

  const rect = disc.getBoundingClientRect()

  let left = rect.left + rect.width / 2 - cRect.width / 2
  left = clamp(left, 8, window.innerWidth - cRect.width - 8)

  let top = rect.top - cRect.height - 10
  if (top < 8) top = rect.bottom + 10
  top = clamp(top, 8, window.innerHeight - cRect.height - 8)

  confirmEl.style.left = `${left}px`
  confirmEl.style.top = `${top}px`
}

function savePosition() {
  const rect = disc.getBoundingClientRect()
  const pos = {
    x: rect.left / window.innerWidth,
    y: rect.top / window.innerHeight
  }
  try {
    chrome.storage.local.set({ [POS_KEY]: pos })
  } catch {
    // 无扩展上下文时忽略
  }
}

function restorePosition() {
  try {
    chrome.storage.local.get(POS_KEY, (res) => {
      const pos = res && res[POS_KEY]
      if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
        setDiscPosition(pos.x * window.innerWidth, pos.y * window.innerHeight)
      } else {
        setDiscPosition(window.innerWidth - 56 - 24, window.innerHeight - 56 - 96)
      }
      clampDiscPosition()
      positionAbs()
      if (panel.classList.contains('db-open')) positionPanel()
    })
  } catch {
    setDiscPosition(window.innerWidth - 56 - 24, window.innerHeight - 56 - 96)
    positionAbs()
  }
}

/* ---------------- 工具 ---------------- */

function togglePanel(force) {
  const open = typeof force === 'boolean' ? force : !panel.classList.contains('db-open')
  panel.classList.toggle('db-open', open)

  if (!open) {
    cancelDelete()
    return
  }

  // 每次打开都按当前内容重新定位，保证整块面板在视口内
  positionPanel()
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

function colorFor(percent) {
  if (percent >= 90) return '#ef4444'
  if (percent >= 80) return '#f97316'
  if (percent >= 60) return '#eab308'
  return '#22c55e'
}

function formatPercent(percent) {
  if (!percent) return '0%'
  if (percent < 0.05) return '<0.1%'
  return percent < 10 ? `${percent.toFixed(1)}%` : `${Math.round(percent)}%`
}

function formatTokens(value) {
  if (value == null) return '—'
  if (value < 0) return '<0'
  if (value < 1000) return `${Math.round(value)}`
  if (value < 1000000) return `${(value / 1000).toFixed(1)}K`
  return `${(value / 1000000).toFixed(2)}M`
}

console.log(TAG, '浮层已挂载（面板内含设置视图）')
