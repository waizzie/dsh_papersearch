/**
 * dsh-papersearch —— Client 半（侧边栏「文献检索」面板）
 *
 * 挂载面：dsh-better-sidebar 的 ctx.betterSidebar.registerTab()，渲染进 DSH 原生右侧栏。
 * 数据面：Host 半的同源路由 /dsh-papersearch/api/*。
 *
 * 两个方向的同步：
 *   面板 → 模型：面板里检索，结果写进 Host 的 panel-store，模型下一次 tool 调用前也能读到；
 *   模型 → 面板：模型跑完 paper_search，面板轮询 /latest 看到 seq 变了就自动换新结果。
 *
 * 纯 JS + React.createElement，无构建步骤；样式只用 --dsw-alias-* 主题令牌。
 */

window.__ModuleLoader__.load({
  id: 'dsh-papersearch',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback } = React;

    const API = '/dsh-papersearch/api/';
    const PREFS_KEY = 'dsh-papersearch:panel:v1';
    const POLL_MS = 3500;

    // ── 内嵌 WoS（仅桌面端）──────────────────────────────────────────
    //
    // 桌面端主窗口开了 webviewTag，但 webview 受 lease 机制管控：
    //   window.dshDesktop.browser.acquire(workspace) -> { lease, partition }
    //   <webview src="about:blank#<lease>" partition="<partition>">
    // 拿到元素后用 executeJavaScript 在 WoS 页面里跑同源 fetch，
    // 于是不需要外部 Chrome，也不需要 CDP 调试端口。
    //
    // 下面这些常量和脚本与 lib/providers/wos.js 保持一致；客户端半拿不到 Host 模块，
    // 只能内联一份，改的时候两边要同步。
    const WOS_PAGE = 'https://www.webofscience.com/wos/woscc/basic-search';
    const WOS_SEARCH_PATH = '/api/wosnx/core/runQuerySearch';
    const WOS_SORT = { relevance: 'relevance', date: 'date', cited: 'times-cited' };
    const WOS_LEASE_WORKSPACE = 'dsh-papersearch';

    function wosBody(query, opts = {}) {
      const limit = Math.min(Math.max(Number(opts.limit) || 10, 1), 50);
      return {
        product: 'WOSCC',
        searchMode: 'general',
        viewType: 'search',
        serviceMode: 'summary',
        search: { database: 'WOSCC', mode: 'general', query: [{ rowField: 'TS', rowText: String(query) }] },
        retrieve: {
          view: 'summary',
          sort: WOS_SORT[opts.sort] || WOS_SORT.relevance,
          first: 1,
          count: limit,
          jcr: false,
          analyzes: null,
        },
        eventMode: null,
      };
    }

    /** 在 WoS 页面里读 SID 并调用检索接口，把原始响应文本带回来。 */
    function wosSearchScript(query, opts) {
      const bodyText = JSON.stringify(wosBody(query, opts));
      return '(async () => {'
        + 'const unquote = (raw) => { if (!raw) return ""; try { const p = JSON.parse(raw); if (typeof p === "string") return p; } catch (e) {} return String(raw).replace(/^"|"$/g, ""); };'
        + 'let sid = "";'
        + 'try { sid = unquote(localStorage.getItem("wos_sid")); } catch (e) {}'
        + 'if (!sid) { try { sid = unquote(localStorage.getItem("sid")); } catch (e) {} }'
        + 'if (!sid) { try { sid = unquote(sessionStorage.getItem("sid")); } catch (e) {} }'
        + 'if (!sid) { const m = location.search.match(/[?&]SID=([^&]+)/); if (m) sid = decodeURIComponent(m[1]); }'
        + 'if (!sid) return JSON.stringify({ ok: false, code: "no-sid", href: location.href });'
        + 'const res = await fetch(' + JSON.stringify(WOS_SEARCH_PATH) + ', {'
        + '  method: "POST", credentials: "include",'
        + '  headers: { "content-type": "application/json", accept: "application/json, text/plain, */*", "x-1p-wos-sid": sid },'
        + '  body: ' + JSON.stringify(bodyText) + ','
        + '});'
        + 'const text = await res.text();'
        + 'return JSON.stringify({ ok: true, status: res.status, text: text });'
        + '})()';
    }

    /** 访客会话的被动验证：在页面里真搜一次。 */
    function wosWarmupScript(query) {
      return '(async () => {'
        + 'const input = document.querySelector("#search-option-0") || document.querySelector(\'input[name="search-main-box"]\');'
        + 'if (!input) return "no-input";'
        + 'const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;'
        + 'setter.call(input, ' + JSON.stringify(String(query)) + ');'
        + 'input.dispatchEvent(new Event("input", { bubbles: true }));'
        + 'input.dispatchEvent(new Event("change", { bubbles: true }));'
        + 'await new Promise((r) => setTimeout(r, 600));'
        + 'const btn = document.querySelector("button.search") || [...document.querySelectorAll("button")].find((b) => (((b.innerText || "") + " " + (b.getAttribute("aria-label") || "")).toLowerCase().includes("search")));'
        + 'if (!btn) return "no-button";'
        + 'btn.click();'
        + 'return "clicked";'
        + '})()';
    }

    /** 桌面端浏览器桥；Web 端没有，返回 null。 */
    function desktopBrowser() {
      const bridge = typeof window !== 'undefined' ? window.dshDesktop : undefined;
      const browser = bridge && bridge.browser;
      return browser && typeof browser.acquire === 'function' ? browser : null;
    }

    // ── 与 Host 通信 ─────────────────────────────────────────────────
    async function call(method, body) {
      const init = body === undefined
        ? { method: 'GET' }
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
      const res = await fetch(API + method, init);
      let json = null;
      try { json = await res.json(); } catch { /* 非 JSON 响应 */ }
      if (!json || json.ok !== true) {
        throw new Error(json?.error?.message ?? `请求失败（HTTP ${res.status}）`);
      }
      return json.value;
    }

    // ── 偏好持久化 ───────────────────────────────────────────────────
    function loadPrefs() {
      try {
        const raw = localStorage.getItem(PREFS_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch { return {}; }
    }

    function savePrefs(prefs) {
      try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* 隐私模式等 */ }
    }

    // ── 展示辅助 ─────────────────────────────────────────────────────
    const SOURCE_LABEL = { wos: 'WoS', cnki: '知网', arxiv: 'arXiv', crossref: 'Crossref' };
    const sourceName = (id) => SOURCE_LABEL[id] ?? id;

    function authorLine(authors) {
      const list = Array.isArray(authors) ? authors : [];
      if (list.length === 0) return '';
      if (list.length <= 3) return list.join(', ');
      return `${list.slice(0, 3).join(', ')} 等 ${list.length} 人`;
    }

    function venueLine(paper) {
      const parts = [];
      if (paper.container) parts.push(paper.container);
      if (paper.year) parts.push(String(paper.year));
      const volIssue = paper.volume
        ? (paper.issue ? `${paper.volume}(${paper.issue})` : paper.volume)
        : '';
      let tail = volIssue;
      if (paper.pages) tail = tail ? `${tail}: ${paper.pages}` : paper.pages;
      if (tail) parts.push(tail);
      return parts.join(' · ');
    }

    function stamp() {
      const d = new Date();
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
    }

    function safeName(text) {
      return String(text || '检索结果').replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 40) || '检索结果';
    }

    // ── 图标 ─────────────────────────────────────────────────────────
    function SearchIcon(size) {
      const s = size ?? 16;
      return h('svg', { width: s, height: s, viewBox: '0 0 24 24', 'aria-hidden': true, style: { display: 'block' } }, [
        h('circle', { key: 'c', cx: 10.5, cy: 10.5, r: 6.2, fill: 'none', stroke: 'currentColor', strokeWidth: 1.7 }),
        h('path', { key: 'l', d: 'M15.2 15.2 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' }),
      ]);
    }

    // ── 样式（组件内渲染，卸载即移除）─────────────────────────────────
    const CSS = `
.ps-root{display:flex;flex-direction:column;height:100%;min-height:0;font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary)}
.ps-head{display:flex;align-items:center;gap:8px;padding:10px 12px 8px;flex:none}
.ps-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--dsw-alias-label-tertiary)}
.ps-dot.on{background:var(--dsw-alias-state-success-primary,#2ea043)}
.ps-dot.off{background:var(--dsw-alias-state-error-primary,#d64545)}
.ps-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.ps-count{color:var(--dsw-alias-label-tertiary);font-size:12px;flex:none}
.ps-search{display:flex;gap:6px;padding:0 12px 8px;flex:none}
.ps-input{flex:1;min-width:0;box-sizing:border-box;background:var(--dsw-alias-bg-layer-2,transparent);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:5px 8px;font-size:12px;font-family:inherit;outline:none}
.ps-input:focus{border-color:var(--dsw-focus-ring-color,var(--dsw-alias-border-l1))}
.ps-btn{cursor:pointer;border:0;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:6px;padding:4px 8px;font-size:12px;font-family:inherit;white-space:nowrap}
.ps-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ps-btn:disabled{opacity:.45;cursor:default}
.ps-btn.primary{color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1)}
.ps-btn.on{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.ps-chips{display:flex;gap:4px;padding:0 12px 8px;flex:none;flex-wrap:wrap;align-items:center}
.ps-chip{cursor:pointer;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-tertiary);border-radius:999px;padding:1px 8px;font-size:11px;font-family:inherit}
.ps-chip.on{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-label-tertiary)}
.ps-wosbar{display:flex;align-items:center;gap:6px;padding:0 12px 8px;flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.ps-wostext{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ps-wvbox{flex:none;overflow:hidden;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2,transparent);transition:height .15s ease}
.ps-opts{display:flex;gap:6px;padding:0 12px 8px;flex:none;flex-wrap:wrap;align-items:center;color:var(--dsw-alias-label-tertiary);font-size:11px}
.ps-select{background:var(--dsw-alias-bg-layer-2,transparent);color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);border-radius:5px;padding:2px 4px;font-size:11px;font-family:inherit}
.ps-bar{display:flex;align-items:center;gap:4px;padding:5px 10px;border-top:1px solid var(--dsw-alias-border-l1);border-bottom:1px solid var(--dsw-alias-border-l1);flex:none;flex-wrap:wrap;background:var(--dsw-alias-bg-layer-2,transparent)}
.ps-barlabel{color:var(--dsw-alias-label-tertiary);font-size:11px;margin-right:2px}
.ps-msg{padding:6px 12px;font-size:12px;color:var(--dsw-alias-label-secondary);flex:none;white-space:pre-wrap}
.ps-msg.err{color:var(--dsw-alias-state-error-primary,#d64545)}
.ps-msg.ok{color:var(--dsw-alias-state-success-primary,#2ea043)}
.ps-msg.warn{color:var(--dsw-alias-state-warn-primary,#b8860b)}
.ps-list{flex:1;min-height:0;overflow:auto}
.ps-row{display:flex;gap:7px;padding:7px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);cursor:pointer}
.ps-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ps-row.open{background:var(--dsw-alias-interactive-bg-hover)}
.ps-row.sel{box-shadow:inset 2px 0 0 var(--dsw-alias-label-tertiary)}
.ps-check{margin:2px 0 0;flex:none;cursor:pointer}
.ps-main{flex:1;min-width:0}
.ps-ptitle{color:var(--dsw-alias-label-primary);font-weight:500;word-break:break-word}
.ps-authors{color:var(--dsw-alias-label-secondary);font-size:12px;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ps-venue{color:var(--dsw-alias-label-tertiary);font-size:12px;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ps-tags{display:flex;gap:5px;align-items:center;margin-top:3px;flex-wrap:wrap}
.ps-badge{display:inline-block;padding:0 5px;border-radius:4px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);font-size:11px}
.ps-doi{color:var(--dsw-alias-label-tertiary);font-size:11px;text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.ps-doi:hover{text-decoration:underline;color:var(--dsw-alias-label-primary)}
.ps-detail{padding:2px 12px 10px 32px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2,transparent)}
.ps-abs{color:var(--dsw-alias-label-secondary);white-space:pre-wrap;font-size:12px;margin:4px 0}
.ps-sub{color:var(--dsw-alias-label-tertiary);font-size:11px;letter-spacing:.04em;margin:8px 0 2px}
.ps-empty{padding:24px 16px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px}
.ps-foot{padding:4px 12px 8px;color:var(--dsw-alias-label-tertiary);font-size:11px;flex:none;word-break:break-all}
`;

    // ── 面板 ─────────────────────────────────────────────────────────
    function PapersPanel() {
      const prefs = useRef(loadPrefs());

      const [query, setQuery] = useState(() => String(prefs.current.query ?? ''));
      const [active, setActive] = useState(() => Array.isArray(prefs.current.active) ? prefs.current.active : null);
      const [sort, setSort] = useState(() => (['relevance', 'date', 'cited'].includes(prefs.current.sort) ? prefs.current.sort : 'relevance'));
      const [limit, setLimit] = useState(() => Number(prefs.current.limit) || 10);

      const [sources, setSources] = useState([]);
      const [browser, setBrowser] = useState(null);
      const [exportDir, setExportDir] = useState('');

      const [data, setData] = useState(null);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const [notice, setNotice] = useState('');

      const [picked, setPicked] = useState(() => new Set());
      const [open, setOpen] = useState(-1);

      const seqRef = useRef(0);

      // 内嵌 WoS 会话（桌面端专属）
      const [wos, setWos] = useState(() => ({
        phase: desktopBrowser() ? 'idle' : 'unsupported',
        message: desktopBrowser() ? '未准备' : '当前环境不支持内嵌浏览器',
        lease: '',
        partition: '',
      }));
      const [wosOpen, setWosOpen] = useState(false);
      const wvRef = useRef(null);
      const leaseRef = useRef('');
      const attachedElRef = useRef(null);
      const attachedLeaseRef = useRef('');
      const watchdogRef = useRef(null);

      // 阶段另存一份 ref：下面的回调必须保持稳定身份，
      // 否则每次 setState 都会让 ref 回调换新，React 会反复 ref(null)/ref(el)，
      // 进而触发「换 lease」分支，造成死循环。
      const phaseRef = useRef(wos.phase);

      const setWosState = useCallback((patch) => {
        setWos((prev) => {
          const next = typeof patch === 'function' ? patch(prev) : { ...prev, ...patch };
          phaseRef.current = next.phase;
          return next;
        });
      }, []);

      // 事件轨迹：用来区分「attach 被拒（零事件）」和「attach 成功但导航失败（有 dom-ready）」
      const traceRef = useRef([]);
      const pushTrace = useCallback((ev, extra) => {
        traceRef.current.push({ ev, t: Date.now() % 1000000, ...(extra || {}) });
        if (traceRef.current.length > 40) traceRef.current.shift();
      }, []);
      const reportTrace = useCallback(async (note) => {
        try {
          await call('webview-probe', { note, phase: phaseRef.current, trace: traceRef.current });
        } catch { /* 上报失败不影响主流程 */ }
      }, []);

      const hrefOf = (el) => {
        try { return el.getURL ? el.getURL() : (el.getAttribute ? el.getAttribute('src') : ''); } catch { return ''; }
      };

      /**
       * 两段看门狗：
       *   attach 阶段 —— 10 秒内没有 did-attach，说明被宿主拒绝（零事件）
       *   加载阶段 —— WoS 首次要 30~40 秒（重定向链很长），给 90 秒
       */
      const armWatchdog = useCallback((stage, ms) => {
        if (watchdogRef.current) { clearTimeout(watchdogRef.current); watchdogRef.current = null; }
        watchdogRef.current = setTimeout(() => {
          watchdogRef.current = null;
          if (phaseRef.current === 'ready') return;
          const attached = traceRef.current.some((r) => r.ev === 'did-attach');
          if (stage === 'attach') {
            if (attached) return; // 已经 attach，交给加载阶段的计时
            void reportTrace('watchdog-attach');
            setWosState((prev) => (prev.phase === 'ready' ? prev : {
              ...prev,
              phase: 'error',
              message: '内嵌窗口没有 attach 成功（零事件）。点「诊断」重发。',
            }));
            return;
          }
          void reportTrace('watchdog-load');
          setWosState((prev) => (prev.phase === 'ready' ? prev : {
            ...prev,
            phase: 'error',
            message: `WoS 页面 ${Math.round(ms / 1000)} 秒内没就绪。点开窗口看看卡在哪，或点「诊断」。`,
          }));
        }, ms);
      }, [setWosState, reportTrace]);

      // 卸载时把 lease 还回去，别在宿主里留下孤儿 guest
      useEffect(() => () => {
        if (watchdogRef.current) { clearTimeout(watchdogRef.current); watchdogRef.current = null; }
        const lease = leaseRef.current;
        if (!lease) return;
        leaseRef.current = '';
        try { desktopBrowser()?.release(lease); } catch { /* 宿主已退出 */ }
      }, []);

      /** 申请一个 guest lease；同一 workspace 复用同一个分区（登录态可持久）。 */
      const ensureWos = useCallback(async (force = false) => {
        const phase = phaseRef.current;
        if (!force && (phase === 'loading' || phase === 'ready' || phase === 'mounting')) return;
        const browser = desktopBrowser();
        if (!browser) {
          setWosState({ phase: 'unsupported', message: '当前环境不支持内嵌浏览器（需桌面端窗口）', lease: '', partition: '' });
          return;
        }
        if (watchdogRef.current) { clearTimeout(watchdogRef.current); watchdogRef.current = null; }
        attachedElRef.current = null;
        attachedLeaseRef.current = '';
        setWosState({ phase: 'loading', message: '正在申请浏览器会话…', lease: '', partition: '' });
        try {
          const got = await browser.acquire(WOS_LEASE_WORKSPACE);
          if (!got || typeof got.lease !== 'string' || typeof got.partition !== 'string') {
            throw new Error(`浏览器桥返回异常：${JSON.stringify(got)}`);
          }
          leaseRef.current = got.lease;
          setWosState({ phase: 'mounting', message: '正在创建内嵌窗口…', lease: got.lease, partition: got.partition });
          setWosOpen(true);

          // attach 阶段看门狗：被拒绝时 webview 会静默空白，不会有任何事件
          armWatchdog('attach', 10000);
        } catch (e) {
          setWosState({ phase: 'error', message: String(e?.message ?? e), lease: '', partition: '' });
        }
      }, [setWosState, reportTrace, armWatchdog]);

      /** webview 元素挂上后接事件：首次 dom-ready 导航到 WoS，之后标记就绪。 */
      const onWvRef = useCallback((el) => {
        if (!el) { wvRef.current = null; return; }
        // React 可能为同一个元素重复回调，直接认领即可
        if (attachedElRef.current === el) { wvRef.current = el; return; }

        const lease = leaseRef.current;
        // 同一个 lease 只能 attach 一次；元素换了而 lease 没换，说明旧 guest 已经用掉它
        if (lease && attachedLeaseRef.current === lease) {
          attachedLeaseRef.current = '';
          attachedElRef.current = null;
          wvRef.current = null;
          void ensureWos(true);
          return;
        }

        attachedElRef.current = el;
        attachedLeaseRef.current = lease;
        wvRef.current = el;
        pushTrace('ref-mounted', { lease: String(lease).slice(0, 8), tag: el.tagName });

        // 轨迹：把这些事件都记下来，attach 是否成功一目了然
        for (const name of ['did-attach', 'did-start-loading', 'did-stop-loading', 'did-navigate', 'did-fail-load', 'dom-ready']) {
          el.addEventListener(name, (event) => {
            pushTrace(name, {
              href: String(hrefOf(el)).slice(0, 90),
              err: event && (event.errorDescription || event.errorCode) ? String(event.errorDescription || event.errorCode).slice(0, 60) : undefined,
            });
          });
        }

        const goWos = () => {
          pushTrace('nav-attempt');
          armWatchdog('load', 90000);
          try {
            const ret = el.loadURL(WOS_PAGE);
            if (ret && typeof ret.catch === 'function') {
              ret.catch((e) => pushTrace('nav-loadURL-rejected', { err: String(e?.message ?? e).slice(0, 120) }));
            }
            pushTrace('nav-loadURL-called');
          } catch (e) {
            pushTrace('nav-loadURL-threw', { err: String(e?.message ?? e).slice(0, 120) });
            try {
              el.setAttribute('src', WOS_PAGE);
              pushTrace('nav-src-set');
            } catch (e2) {
              pushTrace('nav-src-threw', { err: String(e2?.message ?? e2).slice(0, 120) });
            }
          }
        };

        el.addEventListener('dom-ready', () => {
          const href = hrefOf(el);
          if (/webof(science|knowledge)/i.test(href)) {
            if (watchdogRef.current) { clearTimeout(watchdogRef.current); watchdogRef.current = null; }
            phaseRef.current = 'ready'; // 先同步，免得诊断上报读到旧的 phase
            setWosState((prev) => ({ ...prev, phase: 'ready', message: 'WoS 已就绪' }));
            void reportTrace('ready');
          } else {
            setWosState((prev) => ({ ...prev, phase: 'loading', message: '正在打开 Web of Science…' }));
            goWos();
          }
        });

        el.addEventListener('did-fail-load', (event) => {
          // -3 = 被主动取消（导航打断），不算错误
          if (event && event.errorCode === -3) return;
          setWosState((prev) => ({
            ...prev,
            phase: 'error',
            message: `加载失败：${(event && (event.errorDescription || event.errorCode)) || '未知原因'}`,
          }));
          void reportTrace('did-fail-load');
        });
      }, [ensureWos, setWosState, pushTrace, reportTrace, armWatchdog]);

      /** 在 webview 里跑一段脚本。 */
      const execInWv = useCallback(async (script) => {
        const el = wvRef.current;
        if (!el || typeof el.executeJavaScript !== 'function') {
          throw new Error('内嵌窗口还没准备好');
        }
        const raw = await el.executeJavaScript(script, true);
        return typeof raw === 'string' ? raw : JSON.stringify(raw);
      }, []);

      /** 等 webview 的地址变成 WoS summary（被动验证后页面会跳过去）。 */
      const waitSummary = useCallback(async (timeoutMs = 25000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 800));
          try {
            const href = await execInWv('location.href');
            if (typeof href === 'string' && href.includes('/wos/woscc/summary')) return true;
          } catch { /* 页面切换中，继续等 */ }
        }
        return false;
      }, [execInWv]);

      /**
       * 用内嵌 webview 检索 WoS，返回原始响应分片数组。
       * 遇到 passiveVerificationRequired 会先在页面里真搜一次再重试。
       */
      const runWosInWebview = useCallback(async (q, opts) => {
        const first = JSON.parse(await execInWv(wosSearchScript(q, opts)));
        if (!first.ok) {
          throw new Error(first.code === 'no-sid'
            ? `WoS 会话未建立（页面停在 ${first.href || '未知地址'}）：请点开内嵌窗口，等页面加载完再试。`
            : `内嵌检索失败：${first.code || '未知原因'}`);
        }
        if (first.status !== 200) throw new Error(`WoS 检索接口返回 HTTP ${first.status}`);

        let parts;
        try { parts = JSON.parse(first.text); } catch { throw new Error(`WoS 返回的不是 JSON：${String(first.text).slice(0, 160)}`); }
        if (!Array.isArray(parts)) parts = [parts];

        const needsVerify = parts.some((p) => p && p.key === 'error'
          && (Array.isArray(p.payload) ? p.payload : [p.payload]).some((m) => String(m).includes('passiveVerificationRequired')));

        if (needsVerify) {
          setWosState((prev) => ({ ...prev, phase: 'verifying', message: 'WoS 要求验证，正在页面内自动检索一次…' }));
          const action = await execInWv(wosWarmupScript(q));
          if (action !== 'clicked') throw new Error(`自动验证失败（${action}）：请点开内嵌窗口手动搜索一次。`);
          const jumped = await waitSummary();
          if (!jumped) throw new Error('自动验证超时：请点开内嵌窗口手动搜索一次，然后再试。');

          const second = JSON.parse(await execInWv(wosSearchScript(q, opts)));
          if (!second.ok) throw new Error(`重试失败：${second.code || '未知原因'}`);
          parts = JSON.parse(second.text);
          if (!Array.isArray(parts)) parts = [parts];
          setWosState((prev) => ({ ...prev, phase: 'ready', message: 'WoS 已就绪（验证通过）' }));
        }

        return parts;
      }, [execInWv, waitSummary, setWosState]);

      /** 诊断：把内嵌窗口的实际能力上报给 Host，便于回读。 */
      const probeWv = useCallback(async () => {
        try {
          const raw = await execInWv(`JSON.stringify({
            href: location.href,
            title: document.title,
            origin: location.origin,
            sidLocal: (() => { try { return localStorage.getItem('wos_sid') || ''; } catch (e) { return ''; } })(),
            sidUrl: (location.search.match(/[?&]SID=([^&]+)/) || [])[1] || '',
            frames: [...document.querySelectorAll('iframe')].map((f) => String(f.src || '')).slice(0, 6),
            hasInput: Boolean(document.querySelector('#search-option-0') || document.querySelector('input[name="search-main-box"]')),
            bodyLen: String((document.body && document.body.innerHTML) || '').length
          })`);
          const info = JSON.parse(raw);
          await call('webview-probe', { note: 'probe', phase: phaseRef.current, info, trace: traceRef.current });
          setNotice(`探测：${info.title || '(无标题)'} · 输入框 ${info.hasInput ? '有' : '无'} · iframe ${info.frames.length} 个`);
        } catch (e) {
          setError(`探测失败：${String(e?.message ?? e)}`);
          try { await call('webview-probe', { note: 'probe-error', error: String(e?.message ?? e), phase: phaseRef.current, trace: traceRef.current }); } catch { /* noop */ }
        }
      }, [execInWv]);

      // 首次加载：源清单 + 最近一次检索
      useEffect(() => {
        let alive = true;
        (async () => {
          try {
            const info = await call('sources');
            if (!alive) return;
            setSources(Array.isArray(info.sources) ? info.sources : []);
            setBrowser(info.browser ?? null);
            setExportDir(info.exportDir ?? '');
            setActive((prev) => {
              if (Array.isArray(prev) && prev.length > 0) return prev;
              return Array.isArray(info.defaultSources) && info.defaultSources.length > 0
                ? info.defaultSources
                : (info.sources ?? []).map((s) => s.id);
            });
          } catch (e) {
            if (alive) setError(String(e?.message ?? e));
          }
          try {
            const latest = await call('latest');
            if (!alive || !latest) return;
            seqRef.current = latest.seq ?? 0;
            setData(latest);
            setQuery((prev) => prev || latest.query || '');
          } catch { /* 没有历史结果 */ }
        })();
        return () => { alive = false; };
      }, []);

      // 轮询：模型那边搜完，这里自动换结果
      useEffect(() => {
        const timer = setInterval(async () => {
          try {
            const latest = await call('latest');
            if (!latest) return;
            if ((latest.seq ?? 0) !== seqRef.current) {
              seqRef.current = latest.seq ?? 0;
              setData(latest);
              setPicked(new Set());
              setOpen(-1);
            }
          } catch { /* 轮询失败静默 */ }
        }, POLL_MS);
        return () => clearInterval(timer);
      }, []);

      // 偏好落盘
      useEffect(() => {
        savePrefs({ query, active, sort, limit });
      }, [query, active, sort, limit]);

      const runSearch = useCallback(async () => {
        const q = query.trim();
        if (!q || busy) return;
        setBusy(true); setError(''); setNotice('');
        try {
          // WoS 若已在内嵌窗口里就绪，就在这里跑，Host 端不必再启动外部 Chrome。
          let wosParts;
          const list = Array.isArray(active) ? active : [];
          if (list.includes('wos') && wos.phase === 'ready') {
            try {
              wosParts = await runWosInWebview(q, { limit, sort });
            } catch (e) {
              setError(`内嵌 WoS 检索失败：${String(e?.message ?? e)}`);
            }
          }

          const value = await call('search', {
            query: q,
            sources: Array.isArray(active) ? active : undefined,
            limit,
            sort,
            ...(wosParts ? { wosParts } : {}),
          });
          seqRef.current = value.seq ?? 0;
          setData(value);
          setPicked(new Set());
          setOpen(-1);
          if ((value.results ?? []).length === 0) setNotice('没有检索到结果，换个关键词或放宽年份试试。');
        } catch (e) {
          setError(String(e?.message ?? e));
        } finally {
          setBusy(false);
        }
      }, [query, active, limit, sort, busy, wos.phase, runWosInWebview]);

      const doExport = useCallback(async (ext) => {
        if (!data || (data.results ?? []).length === 0) return;
        setError(''); setNotice('');
        try {
          const filename = `${safeName(data.query)}-${stamp()}.${ext}`;
          const value = await call('export', { filename, indices: [...picked] });
          setNotice(`已导出 ${value.count} 条（${value.format.toUpperCase()}）→ ${value.path}`);
        } catch (e) {
          setError(String(e?.message ?? e));
        }
      }, [data, picked]);

      const togglePick = (index) => {
        setPicked((prev) => {
          const next = new Set(prev);
          if (next.has(index)) next.delete(index); else next.add(index);
          return next;
        });
      };

      const results = data?.results ?? [];
      const allPicked = results.length > 0 && picked.size === results.length;

      const wosLabel = wos.phase === 'ready'
        ? 'WoS 内嵌已就绪'
        : wos.phase === 'unsupported'
          ? 'WoS 内嵌不可用（需桌面端）'
          : wos.message;

      const toggleAll = () => {
        setPicked(allPicked ? new Set() : new Set(results.map((_, i) => i)));
      };

      const toggleSource = (id) => {
        setActive((prev) => {
          const list = Array.isArray(prev) ? [...prev] : [];
          const at = list.indexOf(id);
          if (at >= 0) list.splice(at, 1); else list.push(id);
          return list;
        });
      };

      const sourceStats = (data?.perSource ?? [])
        .map((s) => {
          const label = sourceName(s.id);
          if (s.error) return `${label} ✗`;
          return `${label} ${s.count}`;
        })
        .join(' · ');

      return h('div', { className: 'ps-root' }, [
        h('style', { key: 'css' }, CSS),

        // 状态头
        h('div', { key: 'head', className: 'ps-head' }, [
          h('span', {
            key: 'dot',
            className: `ps-dot ${browser ? (browser.available ? 'on' : 'off') : ''}`,
            title: browser
              ? (browser.available ? `浏览器已连接（端口 ${browser.port}）` : `浏览器未连接（端口 ${browser.port}）`)
              : '浏览器状态未知',
          }),
          h('span', { key: 't', className: 'ps-title' }, '文献检索'),
          data ? h('span', { key: 'c', className: 'ps-count' }, `${results.length} 条`) : null,
        ]),

        // 检索行
        h('div', { key: 'search', className: 'ps-search' }, [
          h('input', {
            key: 'q',
            className: 'ps-input',
            placeholder: '关键词，回车检索…',
            value: query,
            spellCheck: false,
            onChange: (e) => setQuery(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') void runSearch(); },
          }),
          h('button', {
            key: 'go',
            className: 'ps-btn primary',
            disabled: busy || !query.trim(),
            onClick: () => void runSearch(),
          }, busy ? '检索中…' : '检索'),
        ]),

        // 源开关
        h('div', { key: 'chips', className: 'ps-chips' }, [
          ...sources.map((s) => h('button', {
            key: s.id,
            className: `ps-chip ${Array.isArray(active) && active.includes(s.id) ? 'on' : ''}`,
            title: s.transport === 'browser' ? `${s.label}：需要浏览器会话` : `${s.label}：免登录`,
            onClick: () => toggleSource(s.id),
          }, sourceName(s.id))),
          h('button', {
            key: 'opts',
            className: 'ps-btn',
            style: { marginLeft: 'auto', padding: '1px 6px', fontSize: '11px' },
            onClick: () => setOpen((v) => (v === -2 ? -1 : -2)),
            title: '更多选项',
          }, '⋯'),
        ]),

        // 内嵌 WoS 会话（桌面端专属；Web 端显示为不可用）
        h('div', { key: 'wosbar', className: 'ps-wosbar' }, [
          h('span', {
            key: 'dot',
            className: `ps-dot ${wos.phase === 'ready' ? 'on' : (wos.phase === 'error' || wos.phase === 'unsupported') ? 'off' : ''}`,
            title: wos.message,
          }),
          h('span', { key: 't', className: 'ps-wostext', title: wos.message }, wosLabel),
          (wos.phase === 'idle' || wos.phase === 'error')
            ? h('button', { key: 'prep', className: 'ps-btn', onClick: () => void ensureWos(wos.phase === 'error') }, wos.phase === 'error' ? '重试' : '准备')
            : null,
          (wos.lease && wos.phase !== 'error')
            ? h('button', { key: 'toggle', className: 'ps-btn', onClick: () => setWosOpen((v) => !v) }, wosOpen ? '收起' : '展开')
            : null,
          (wos.phase === 'ready' || wos.phase === 'error')
            ? h('button', {
              key: 'probe',
              className: 'ps-btn',
              onClick: () => void (wos.phase === 'ready' ? probeWv() : reportTrace('manual')),
            }, wos.phase === 'ready' ? '测试' : '诊断')
            : null,
        ]),

        // webview 本体：lease 拿到后才创建；收起时高度归零但元素保留（guest 不能销毁）
        wos.lease
          ? h('div', { key: 'wvbox', className: 'ps-wvbox', style: { height: wosOpen ? 340 : 0 } }, [
            h('webview', {
              key: 'wv',
              ref: onWvRef,
              // partition 必须排在 src 之前：attach 校验时两个属性都得已就位
              partition: wos.partition,
              src: `about:blank#${wos.lease}`,
              style: { width: '100%', height: '340px', display: 'block', border: '0' },
            }),
          ])
          : null,

        // 选项
        open === -2 ? h('div', { key: 'opts', className: 'ps-opts' }, [
          h('span', { key: 'sl' }, '排序'),
          h('select', {
            key: 'sort',
            className: 'ps-select',
            value: sort,
            onChange: (e) => setSort(e.target.value),
          }, [
            h('option', { key: 'r', value: 'relevance' }, '相关度'),
            h('option', { key: 'd', value: 'date' }, '时间'),
            h('option', { key: 'c', value: 'cited' }, '被引'),
          ]),
          h('span', { key: 'll', style: { marginLeft: '6px' } }, '每源'),
          h('select', {
            key: 'limit',
            className: 'ps-select',
            value: limit,
            onChange: (e) => setLimit(Number(e.target.value)),
          }, [10, 20, 30, 50].map((n) => h('option', { key: n, value: n }, String(n)))),
        ]) : null,

        // 结果状态
        data && sourceStats ? h('div', { key: 'stats', className: 'ps-msg' }, sourceStats) : null,
        data && data.origin === 'tool' ? h('div', { key: 'origin', className: 'ps-msg' }, '↑ 来自会话里的 paper_search') : null,
        (data?.warnings ?? []).map((w, i) => h('div', { key: `w${i}`, className: 'ps-msg warn' }, w)),
        error ? h('div', { key: 'err', className: 'ps-msg err' }, error) : null,
        notice ? h('div', { key: 'note', className: 'ps-msg ok' }, notice) : null,

        // 操作条
        results.length > 0 ? h('div', { key: 'bar', className: 'ps-bar' }, [
          h('button', { key: 'all', className: 'ps-btn', onClick: toggleAll }, allPicked ? '取消全选' : '全选'),
          h('span', { key: 'sel', className: 'ps-barlabel' }, picked.size > 0 ? `已选 ${picked.size}` : '未选'),
          h('span', { key: 'sp', style: { flex: 1 } }),
          h('button', { key: 'csv', className: 'ps-btn', onClick: () => void doExport('csv') }, 'CSV'),
          h('button', { key: 'json', className: 'ps-btn', onClick: () => void doExport('json') }, 'JSON'),
          h('button', { key: 'bib', className: 'ps-btn', onClick: () => void doExport('bib') }, 'BibTeX'),
        ]) : null,

        // 列表
        h('div', { key: 'list', className: 'ps-list' }, results.length === 0
          ? [h('div', { key: 'empty', className: 'ps-empty' }, busy
            ? '检索中…'
            : '还没有结果。\n在上面输入关键词检索，或在会话里让我用 paper_search 搜一次。')]
          : results.map((paper, index) => {
            const isOpen = open === index;
            const doi = paper.doi ? String(paper.doi) : '';
            const url = paper.url ? String(paper.url) : '';
            const authors = authorLine(paper.authors);
            const venue = venueLine(paper);
            const alsoIn = Array.isArray(paper.alsoIn) ? paper.alsoIn : [];
            return h(React.Fragment, { key: `${index}-${doi || paper.title}` }, [
              h('div', {
                key: 'row',
                className: `ps-row ${isOpen ? 'open' : ''} ${picked.has(index) ? 'sel' : ''}`,
                onClick: () => setOpen(isOpen ? -1 : index),
              }, [
                h('input', {
                  key: 'cb',
                  className: 'ps-check',
                  type: 'checkbox',
                  checked: picked.has(index),
                  onClick: (e) => e.stopPropagation(),
                  onChange: () => togglePick(index),
                }),
                h('div', { key: 'main', className: 'ps-main' }, [
                  h('div', { key: 't', className: 'ps-ptitle' }, paper.title || '(无标题)'),
                  authors ? h('div', { key: 'a', className: 'ps-authors' }, authors) : null,
                  venue ? h('div', { key: 'v', className: 'ps-venue' }, venue) : null,
                  h('div', { key: 'tags', className: 'ps-tags' }, [
                    h('span', { key: 'src', className: 'ps-badge' }, sourceName(paper.source)),
                    ...alsoIn.map((s) => h('span', { key: `in-${s}`, className: 'ps-badge' }, `另见 ${sourceName(s)}`)),
                    paper.citedBy !== null && paper.citedBy !== undefined
                      ? h('span', { key: 'cited', className: 'ps-badge' }, `被引 ${paper.citedBy}`)
                      : null,
                    doi ? h('a', {
                      key: 'doi',
                      className: 'ps-doi',
                      href: `https://doi.org/${doi}`,
                      target: '_blank',
                      rel: 'noreferrer',
                      onClick: (e) => e.stopPropagation(),
                      title: doi,
                    }, doi) : null,
                  ]),
                ]),
              ]),
              isOpen ? h('div', { key: 'detail', className: 'ps-detail' }, [
                paper.abstract
                  ? h('div', { key: 'abs', className: 'ps-abs' }, paper.abstract)
                  : h('div', { key: 'noabs', className: 'ps-msg' }, '（该来源未提供摘要）'),
                (Array.isArray(paper.authors) && paper.authors.length > 3)
                  ? h('div', { key: 'alla', className: 'ps-sub' }, `全部作者：${paper.authors.join(', ')}`)
                  : null,
                url ? h('div', { key: 'url', className: 'ps-sub' }, [
                  h('a', { key: 'u', href: url, target: '_blank', rel: 'noreferrer', className: 'ps-doi' }, url),
                ]) : null,
              ]) : null,
            ]);
          })),

        // 页脚：导出目录提示
        exportDir ? h('div', { key: 'foot', className: 'ps-foot' }, `导出目录：${exportDir}`) : null,
      ]);
    }

    // ── 挂到 better-sidebar（可选依赖，缺失只降级不报错）────────────────
    const SERVICE_NAME = 'betterSidebar';

    function buildTabDescriptor() {
      return {
        id: 'dsh-papersearch:search',
        title: () => '文献检索',
        description: () => '在侧栏按关键词检索 WoS / 知网 / arXiv / Crossref，结果可勾选导出',
        icon: (size) => SearchIcon(size),
        order: 45,
        single: true,
        component: PapersPanel,
      };
    }

    function attach(ctx, service, scopedCtx) {
      if (!service || typeof service.registerTab !== 'function') return false;
      try {
        const register = () => service.registerTab(buildTabDescriptor());
        const owner = scopedCtx ?? ctx;
        if (typeof owner?.effect === 'function') owner.effect(register, 'dsh-papersearch: sidebar tab');
        else register();
        return true;
      } catch (e) {
        try { console.warn('[dsh-papersearch] 侧栏面板挂载失败：', e?.message ?? e); } catch { /* noop */ }
        return false;
      }
    }

    function attachSidebar(ctx) {
      try {
        const existing = typeof ctx?.get === 'function' ? ctx.get(SERVICE_NAME) : undefined;
        if (existing) { attach(ctx, existing, ctx); return; }
      } catch { /* 继续走注入等待 */ }

      try {
        if (typeof ctx?.inject === 'function') {
          ctx.inject([SERVICE_NAME], (scoped) => {
            const service = (typeof scoped?.get === 'function' ? scoped.get(SERVICE_NAME) : undefined)
              ?? scoped?.[SERVICE_NAME];
            attach(ctx, service, scoped);
          });
        }
      } catch (e) {
        try { console.warn('[dsh-papersearch] 等待侧栏服务失败：', e?.message ?? e); } catch { /* noop */ }
      }
    }

    return {
      inject: [],
      apply(ctx) {
        attachSidebar(ctx);
      },
    };
  },
});
