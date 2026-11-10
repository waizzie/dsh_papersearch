/**
 * Web of Science provider —— 走新版 SPA 的检索引擎。
 *
 * 实测要点（2026-10-28，本机真实会话）：
 * 1. 站点会把 www.webofscience.com 重定向到区域域名（webofscience.clarivate.cn），
 *    所以不能写死 origin，只按 host 含 "webofscience" 判断。
 * 2. 会话 SID 在 `localStorage["wos_sid"]`，值是 **JSON 字符串**（带引号）；
 *    地址栏 `?SID=` 里也有一份。读不到就说明会话没建立。
 * 3. 访客（未登录）也能检索，但首次调用 API 会返回
 *    `Server.passiveVerificationRequired`——必须先在页面里真正发起一次检索，
 *    会话才会通过验证。因此这里带一个 warm-up：驱动页面 UI 搜一次，再重试接口。
 * 4. `records` 分片的 payload 是**以序号为键的对象**（{"1":{…}}），不是数组。
 * 5. 作者项可能含 null，且没有 display_name，需要 wos_standard / first+last 兜底。
 * 6. 错误分片的 HTTP 状态码仍是 200，必须按 `key === "error"` 判错。
 *
 * 两条执行路径共用下面的常量与解析函数：
 *   - 面板路径（默认）：Host 把请求交给侧栏面板，面板在内嵌 webview 里跑同源 fetch，
 *     原始分片回传 Host 解释（lib/wos-bridge.js）。不启动任何外部浏览器窗口。
 *   - CDP 路径（仅在 config.wosTransport = 'cdp' 时启用）：外部 Chrome + page.inPageFetch。
 */

import { stripHtml } from '../http.js';
import { makePaper } from '../paper.js';

export const WOS_PAGE_URL = 'https://www.webofscience.com/wos/woscc/basic-search';
export const WOS_SEARCH_PATH = '/api/wosnx/core/runQuerySearch';

export const WOS_SORT = { relevance: 'relevance', date: 'date-descending', cited: 'times-cited-descending' };

/**
 * 读会话 SID。两条路都用同一段脚本：
 * CDP 路径喂给 page.evaluate，内嵌 webview 路径喂给 webview.executeJavaScript。
 */
export const WOS_SID_READER = `(() => {
  const unquote = (raw) => {
    if (!raw) return '';
    try { const parsed = JSON.parse(raw); if (typeof parsed === 'string') return parsed; } catch (e) { /* 不是 JSON */ }
    return String(raw).replace(/^"|"$/g, '');
  };
  try { const v = unquote(localStorage.getItem('wos_sid')); if (v) return v; } catch (e) { /* noop */ }
  try { const v = unquote(localStorage.getItem('sid')); if (v) return v; } catch (e) { /* noop */ }
  try { const v = unquote(sessionStorage.getItem('sid')); if (v) return v; } catch (e) { /* noop */ }
  const m = location.search.match(/[?&]SID=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : '';
})()`;

/** 在 WoS 页面里真实发起一次检索（填 Topic + 点 Search），用于通过访客被动验证。 */
export const WOS_WARMUP_SCRIPT = (query) => `(async () => {
  const input = document.querySelector('#search-option-0')
    || document.querySelector('input[name="search-main-box"]');
  if (!input) return 'no-input';
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, ${JSON.stringify(String(query))});
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 600));
  const btn = document.querySelector('button.search')
    || [...document.querySelectorAll('button')].find((b) => (((b.innerText || '') + ' ' + (b.getAttribute('aria-label') || '')).toLowerCase().includes('search')));
  if (!btn) return 'no-button';
  btn.click();
  return 'clicked';
})()`;

/** 构造 runQuerySearch 的请求体。 */
export function buildWosBody(query, { limit = 10, sort = 'relevance', yearFrom, yearTo } = {}) {
  // 有年份条件时多取一些，由上层按年份过滤
  const wanted = (Number.isFinite(yearFrom) || Number.isFinite(yearTo))
    ? Math.min(Math.max(limit * 3, 20), 50)
    : Math.min(Math.max(limit, 1), 50);
  return {
    product: 'WOSCC',
    searchMode: 'general',
    viewType: 'search',
    serviceMode: 'summary',
    search: {
      database: 'WOSCC',
      mode: 'general',
      query: [{ rowField: 'TS', rowText: String(query) }],
    },
    retrieve: {
      view: 'summary',
      sort: WOS_SORT[sort] ?? WOS_SORT.relevance,
      first: 1,
      count: wanted,
      jcr: false,
      analyzes: null,
    },
    eventMode: null,
  };
}

/**
 * 把 WoS 的响应分片数组解释成归一化结果。
 * CDP 路径（页面内 fetch）和内嵌 webview 路径（把原始分片回传 Host）共用这一份。
 */
export function interpretWosParts(parts, limit = 10) {
  const list = Array.isArray(parts) ? parts : [parts];

  const errorPart = list.find((p) => p?.key === 'error');
  if (errorPart) throw new Error(describeWosError(errorPart.payload));

  const recordsPart = list.find((p) => p?.key === 'records');
  if (!recordsPart) {
    const seen = list.map((p) => p?.key).filter(Boolean).join(', ');
    throw new Error(`WoS 响应缺少 records 分片（收到的分片：${seen || '无'}）。`);
  }

  const payload = recordsPart.payload;
  const raw = Array.isArray(payload) ? payload : Object.values(payload ?? {});
  const items = raw.map(normalizeWosRecord).filter(Boolean).slice(0, limit);

  const info = list.find((p) => p?.key === 'searchInfo');
  const total = Number(info?.payload?.RecordsFound);

  return {
    items,
    total: Number.isFinite(total) ? total : undefined,
    warnings: items.length === 0
      ? ['WoS 未返回匹配结果（TS 检索的是主题词，建议用英文关键词）。']
      : [],
  };
}

/** 分片里是否带了某个错误码（如 passiveVerificationRequired）。 */
export function wosPartsHaveError(parts, code) {
  return hasError(Array.isArray(parts) ? parts : [parts], code);
}

const isWosHost = (href) => {
  if (!href) return false;
  try { return /webofscience/i.test(new URL(href).hostname); } catch { return /webofscience/i.test(href); }
};

export const wosProvider = {
  id: 'wos',
  label: 'Web of Science',
  aliases: ['sci', 'webofscience', 'wos', 'SCI', 'WOS', 'webofscience.com'],
  transport: 'browser',
  loginUrl: WOS_PAGE_URL,
  note: '桌面端走侧栏「文献检索」面板的内嵌 WoS 窗口检索，不会弹外部浏览器；面板会自动准备内嵌窗口。',

  async search(input, ctx) {
    const transport = String(ctx?.config?.wosTransport ?? 'panel').toLowerCase();
    if (transport === 'cdp') return searchViaCdp(input, ctx);
    return searchViaPanel(input, ctx);
  },
};

/**
 * 默认路径：把检索交给侧栏面板，在它的内嵌 webview 里执行。
 * 面板没连上时立刻给出可读原因，不启动外部 Chrome。
 */
async function searchViaPanel({ query, limit, yearFrom, yearTo, sort }, ctx) {
  const bridge = ctx?.wosBridge;
  if (!bridge || typeof bridge.enqueue !== 'function') {
    throw new Error('WoS 面板桥未启用（插件版本过旧或未重新加载）。请重启 DSH 后重试。');
  }
  const parts = await bridge.enqueue(
    { query, limit, sort, yearFrom, yearTo },
    {
      // 面板可能要先加载/唤醒内嵌 WoS（30~40 秒），给它比普通 HTTP 源更宽的余量
      timeoutMs: Math.min(Math.max(Number(ctx?.timeoutMs) || 30000, 15000) + 25000, 90000),
      signal: ctx?.signal,
    },
  );
  const interpreted = interpretWosParts(parts, limit);
  return {
    items: interpreted.items,
    total: interpreted.total,
    warnings: interpreted.warnings,
  };
}

/** 兼容路径：外部 Chrome + CDP（只有显式配置 wosTransport: 'cdp' 才会走到）。 */
async function searchViaCdp({ query, limit, yearFrom, yearTo, sort }, ctx) {
  // 优先复用浏览器里已经打开的 WoS 标签页：既能保住已通过验证的会话，也避免重复开页
  let targetUrl = WOS_PAGE_URL;
  try {
    const targets = await ctx.browser.listTargets();
    const existing = targets.find((t) => isWosHost(t.url));
    if (existing) targetUrl = existing.url;
  } catch { /* 列不出来就退回默认地址 */ }

  const page = await ctx.browser.page(targetUrl);

  const href = await page.evaluate('location.href').catch(() => '');
  if (href && !isWosHost(href)) {
    throw new Error(
      `WoS 会话未建立：页面停留在 ${href}。`
      + '请在浏览器窗口里打开 Web of Science（必要时登录），然后重试。',
    );
  }

  let sid = await waitForSid(page);
  if (!sid) {
    throw new Error(
      'WoS 会话未建立：页面上读不到 SID（localStorage.wos_sid 为空）。'
      + '请用 paper_browser 打开 https://www.webofscience.com/wos/woscc/basic-search，'
      + '等页面加载完（地址栏出现 ?SID=…）后再重试。',
    );
  }

  const body = buildWosBody(query, { limit, sort, yearFrom, yearTo });

  let parts = await callSearch(page, sid, body);

  // 访客会话首次检索会被要求"被动验证"——在页面里真搜一次即可放行
  if (wosPartsHaveError(parts, 'passiveVerificationRequired')) {
    ctx.log?.('wos: 触发一次页面内检索以通过被动验证');
    const warmed = await warmUp(page, query);
    if (!warmed) {
      throw new Error('WoS 要求人机验证，自动触发失败。请在浏览器窗口里手动搜索一次，然后重试。');
    }
    sid = (await waitForSid(page)) || sid;
    parts = await callSearch(page, sid, body);
  }

  const interpreted = interpretWosParts(parts, limit);
  return {
    items: interpreted.items,
    total: interpreted.total,
    warnings: interpreted.warnings,
  };
}

async function callSearch(page, sid, body) {
  const res = await page.inPageFetch(WOS_SEARCH_PATH, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/plain, */*',
      'x-1p-wos-sid': sid,
    },
    body: JSON.stringify(body),
  });
  if (res.status !== 200) {
    throw new Error(`WoS 检索接口返回 HTTP ${res.status}：${res.text.slice(0, 200)}`);
  }
  let parts;
  try {
    parts = JSON.parse(res.text);
  } catch {
    throw new Error(`WoS 返回的不是 JSON：${res.text.slice(0, 200)}`);
  }
  return Array.isArray(parts) ? parts : [parts];
}

function hasError(parts, code) {
  return parts.some((p) => p?.key === 'error'
    && (Array.isArray(p.payload) ? p.payload : [p.payload]).some((m) => String(m).includes(code)));
}

/**
 * 在页面里真实发起一次检索（填 Topic + 点 Search），让会话通过被动验证。
 * 这是用户本来也要做的动作，只是由插件代劳。
 */
async function warmUp(page, query, { timeoutMs = 30000 } = {}) {
  const action = await page.evaluate(WOS_WARMUP_SCRIPT(query)).catch(() => 'error');
  if (action !== 'clicked') return false;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    const href = await page.evaluate('location.href').catch(() => '');
    if (typeof href === 'string' && href.includes('/wos/woscc/summary')) return true;
  }
  return false;
}

async function waitForSid(page, { timeoutMs = 10000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    last = await page.evaluate(WOS_SID_READER).catch(() => '');
    if (last) return last;
    await new Promise((r) => setTimeout(r, 500));
  }
  return last;
}

function describeWosError(payload) {
  const messages = (Array.isArray(payload) ? payload : [payload]).map(String);
  const joined = messages.join('；');
  if (/sessionNotFound|sessionExpired/i.test(joined)) {
    return `WoS 会话已失效（${joined}）：请在侧栏面板里点「重试」重新加载内嵌窗口，然后再检索。`;
  }
  if (/passiveVerificationRequired/i.test(joined)) {
    return 'WoS 要求人机验证：请点「展开」，在内嵌窗口里完成验证或手动检索一次，然后重试。';
  }
  if (/authorization|no access/i.test(joined)) {
    return `当前账号/机构没有该库的访问权限（${joined}）。`;
  }
  if (/authentication/i.test(joined)) {
    return `WoS 认证失败（${joined}）：请在内嵌窗口里重新登录。`;
  }
  if (/Invocation error/i.test(joined)) {
    return `WoS 接口拒绝了这次请求（${joined}）：多半是排序/条数参数不被接受，或内嵌会话需要刷新。请点「重试」后再检索。`;
  }
  return `WoS 拒绝检索：${joined}`;
}

/** 按真实响应结构归一化（字段路径均已用活体响应核对）。 */
function normalizeWosRecord(ri) {
  if (!ri || typeof ri !== 'object') return null;

  const title = firstTitle(ri.titles?.item);
  if (!title) return null;

  const authorsRaw = ri.names?.author?.en ?? [];
  const authors = (Array.isArray(authorsRaw) ? authorsRaw : [])
    .filter(Boolean)
    .map((a) => a.display_name || a.wos_standard
      || [a.first_name, a.last_name].filter(Boolean).join(' '))
    .filter(Boolean);

  const identifiers = Array.isArray(ri.identifiers) ? ri.identifiers : [];
  const doi = ri.doi
    || identifiers.find((x) => String(x?.type ?? '').toLowerCase() === 'doi')?.value
    || '';
  const ut = ri.id?.value || ri.colluid || '';

  const abstractRaw = ri.abstract?.basic?.en?.abstract ?? '';

  return makePaper('wos', {
    sourceId: ut,
    title,
    authors,
    container: firstTitle(ri.titles?.source),
    year: ri.pub_info?.pubyear ?? null,
    volume: ri.pub_info?.vol ?? '',
    issue: ri.pub_info?.issue ?? '',
    pages: ri.pub_info?.page_no ?? '',
    doi,
    citedBy: ri.citation_related?.counts?.WOSCC ?? null,
    abstract: abstractRaw ? stripHtml(abstractRaw) : '',
    url: ut ? `https://www.webofscience.com/wos/woscc/full-record/${encodeURIComponent(ut)}` : '',
    type: Array.isArray(ri.doctypes) && ri.doctypes.length > 0
      ? String(ri.doctypes[0]).toLowerCase()
      : 'article',
    language: 'en',
  });
}

/** 多语言标题容器取第一个可用标题。 */
function firstTitle(container) {
  if (!container) return '';
  for (const value of Object.values(container)) {
    if (Array.isArray(value) && value[0]?.title) return String(value[0].title);
    if (value && typeof value === 'object' && value.title) return String(value.title);
  }
  return '';
}
