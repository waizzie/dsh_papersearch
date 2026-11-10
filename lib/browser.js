/**
 * 浏览器传输层：通过 Chrome DevTools Protocol 驱动**用户自己启动的 Chrome**。
 *
 * 为什么不是"插件拉起浏览器"：DSH 的工具进程跑在 Low Integrity 沙箱里，
 * Chrome 在该环境下 crashpad 会直接自杀（OpenProcess 拒绝访问），拉不起来。
 * 所以本插件只做 CDP **客户端**：用户双击一次 scripts/start-browser.cmd，
 * 之后所有检索都在那个已登录的浏览器里、以同源 fetch 的方式完成，
 * 天然带上机构 IP 认证 / 知网验证码通过后的会话。
 *
 * 依赖：Node >= 22（内置 WebSocket）。零第三方依赖。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export class BrowserUnavailableError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'BrowserUnavailableError';
    this.detail = detail;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 单个 CDP 连接（一个 page target）。 */
class CdpSession {
  constructor(wsUrl, { defaultTimeoutMs = 30000 } = {}) {
    this.wsUrl = wsUrl;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP WebSocket 连接超时')), 15000);
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.ws.addEventListener('error', (event) => {
        clearTimeout(timer);
        reject(new Error(`CDP WebSocket 连接失败：${event?.message ?? 'unknown'}`));
      }, { once: true });
    });
    this.ws.addEventListener('message', (event) => this.#onMessage(event));
    this.ws.addEventListener('close', () => {
      this.closed = true;
      for (const { reject } of this.pending.values()) reject(new Error('CDP 连接已关闭'));
      this.pending.clear();
    });
    return this;
  }

  #onMessage(event) {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject, timer } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(timer);
      if (msg.error) reject(new Error(`CDP ${msg.error.message}${msg.error.data ? `：${msg.error.data}` : ''}`));
      else resolve(msg.result);
      return;
    }
    if (msg.method) {
      const handlers = this.listeners.get(msg.method) ?? [];
      for (const handler of handlers) { try { handler(msg.params); } catch { /* 监听器自身异常不影响主流程 */ } }
    }
  }

  send(method, params = {}, timeoutMs = this.defaultTimeoutMs) {
    if (this.closed) return Promise.reject(new Error('CDP 连接已关闭'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 调用超时（${method}，${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, handler) {
    const list = this.listeners.get(method) ?? [];
    list.push(handler);
    this.listeners.set(method, list);
  }

  close() {
    this.closed = true;
    try { this.ws?.close(); } catch { /* 已关闭 */ }
  }
}

/** 一个可操作的页面。 */
class Page {
  constructor(session, targetId, port) {
    this.session = session;
    this.targetId = targetId;
    this.port = port;
  }

  get url() { return this.currentUrl ?? ''; }

  async evaluate(expression, { awaitPromise = false, timeoutMs = 30000 } = {}) {
    const result = await this.session.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    }, timeoutMs);
    if (result.exceptionDetails) {
      const desc = result.exceptionDetails.exception?.description
        ?? result.exceptionDetails.text
        ?? '页面脚本执行失败';
      throw new Error(`页面内脚本异常：${String(desc).split('\n')[0]}`);
    }
    return result.result?.value;
  }

  /**
   * 导航到 url 并等**真正的页面**就绪。
   * 不能只看 readyState：about:blank 立刻就是 complete，会在导航开始前就返回。
   */
  async goto(url, { timeoutMs = 45000 } = {}) {
    await this.session.send('Page.navigate', { url }, timeoutMs);
    const deadline = Date.now() + timeoutMs;
    let href = '';
    while (Date.now() < deadline) {
      const state = await this.evaluate('document.readyState').catch(() => '');
      href = await this.evaluate('location.href').catch(() => '');
      const navigated = href && href !== 'about:blank' && /^https?:/i.test(href);
      if (navigated && state === 'complete') {
        this.currentUrl = href;
        return href;
      }
      await sleep(300);
    }
    this.currentUrl = href || url;
    return this.currentUrl;
  }

  /** 轮询 document.readyState，直到 complete（或超时）。 */
  async waitReady({ timeoutMs = 20000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = await this.evaluate('document.readyState').catch(() => null);
      if (state === 'complete') return true;
      await sleep(300);
    }
    return false;
  }

  /**
   * 在**页面上下文里**发请求——这是绕过反爬的关键：
   * 同源请求自动携带该站点的 Cookie、Referer、以及站点自己维护的会话状态。
   */
  async inPageFetch(url, { method = 'GET', headers = {}, body = null, timeoutMs = 40000 } = {}) {
    const payload = JSON.stringify({ url, method, headers, body });
    const expression = `(async () => {
      const req = ${payload};
      const init = { method: req.method, headers: req.headers, credentials: 'include' };
      if (req.body !== null && req.body !== undefined) init.body = req.body;
      try {
        const res = await fetch(req.url, init);
        const text = await res.text();
        return { ok: res.ok, status: res.status, contentType: res.headers.get('content-type') || '', text };
      } catch (error) {
        return { ok: false, status: 0, contentType: '', text: '', error: String(error && error.message || error) };
      }
    })()`;
    const value = await this.evaluate(expression, { awaitPromise: true, timeoutMs });
    if (!value) throw new Error('页面内请求没有返回结果');
    if (value.error) throw new Error(`页面内请求失败：${value.error}（${url}）`);
    return value;
  }

  async close() {
    this.session.close();
    try {
      await fetch(`http://127.0.0.1:${this.port}/json/close/${this.targetId}`);
    } catch { /* 关闭失败不影响结果 */ }
  }
}

/**
 * 引擎：连接/启动 Chrome，并按 origin 复用标签页。
 */
export function createBrowserEngine({ port = 9222, chromePath = '', profileDir = '', packageDir = '', log = () => {} } = {}) {
  const endpoint = (path) => `http://127.0.0.1:${port}${path}`;
  const pages = new Map(); // origin -> Page

  function launcherPath() {
    return packageDir ? join(packageDir, 'scripts', 'start-browser.cmd') : '';
  }

  function launchHint() {
    const cmd = launcherPath();
    return cmd && existsSync(cmd)
      ? `请双击运行：${cmd}`
      : `请手动启动 Chrome：chrome.exe --remote-debugging-port=${port} --user-data-dir="<一个专用目录>"`;
  }

  /** 调试端口是否可用。 */
  async function probe() {
    try {
      const res = await fetch(endpoint('/json/version'), { signal: AbortSignal.timeout(2500) });
      if (!res.ok) return { available: false, port, message: `调试端口 ${port} 返回 HTTP ${res.status}` };
      const info = await res.json();
      return { available: true, port, browser: info.Browser ?? '', protocol: info['Protocol-Version'] ?? '', webSocketDebuggerUrl: info.webSocketDebuggerUrl ?? '' };
    } catch (error) {
      const reason = error.name === 'TimeoutError'
        ? '连接超时'
        : /fetch failed|ECONNREFUSED|ECONNRESET/i.test(String(error.message))
          ? '连接被拒绝（Chrome 未启动或调试端口未开启）'
          : error.message;
      return {
        available: false,
        port,
        message: `调试端口 ${port} 未监听（${reason}）`,
        hint: launchHint(),
        launcher: launcherPath(),
      };
    }
  }

  /** 尽力拉起 Chrome（在 High/Medium IL 下可行；Low IL 沙箱内必然失败，此时给出可读提示）。 */
  async function launch({ url = 'about:blank' } = {}) {
    const before = await probe();
    if (before.available) return { launched: false, alreadyRunning: true, ...before };
    if (!chromePath || !existsSync(chromePath)) {
      throw new BrowserUnavailableError(`找不到 Chrome：${chromePath || '(未配置 chromePath)'}。${launchHint()}`, before);
    }
    const userDataDir = profileDir || join(process.env.LOCALAPPDATA ?? process.cwd(), 'dsh-papersearch', 'chrome-profile');
    try { mkdirSync(userDataDir, { recursive: true }); } catch { /* 目录已存在 */ }
    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      '--remote-allow-origins=*',
      '--no-first-run',
      '--no-default-browser-check',
      url,
    ];
    try {
      const child = spawn(chromePath, args, { detached: true, stdio: 'ignore' });
      child.unref();
    } catch (error) {
      throw new BrowserUnavailableError(
        `无法启动 Chrome（${error.message}）。${launchHint()}`,
        { ...before, cause: error.message },
      );
    }
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      await sleep(600);
      const now = await probe();
      if (now.available) return { launched: true, alreadyRunning: false, ...now };
    }
    throw new BrowserUnavailableError(
      `Chrome 未能建立调试端口 ${port}（本机 DSH 工具进程处于 Low Integrity 沙箱，无法启动浏览器）。${launchHint()}`,
      before,
    );
  }

  /** 取一个页面：同 origin 已有则复用，否则新建。 */
  async function page(url, { reuse = true, timeoutMs = 30000 } = {}) {
    const status = await probe();
    if (!status.available) {
      throw new BrowserUnavailableError(
        `浏览器调试端口 ${port} 未就绪。${launchHint()}`,
        status,
      );
    }
    let origin = '';
    try { origin = new URL(url).origin; } catch { origin = ''; }

    const existing = reuse && origin ? pages.get(origin) : null;
    if (existing && !existing.session.closed) {
      await existing.goto(url, { timeoutMs });
      return existing;
    }

    // 优先复用 Chrome 里已经打开的同源标签页（避免重复开页，也保住用户已登录的页面）
    const target = (reuse && origin ? await findTargetByOrigin(origin) : null) ?? await createTarget();
    const session = await new CdpSession(target.webSocketDebuggerUrl).connect();
    await session.send('Runtime.enable');
    await session.send('Page.enable');
    const created = new Page(session, target.id, port);
    if (origin) pages.set(origin, created);
    // 新标签页可能是 about:blank 起步，显式导航并等页面真正加载完
    await created.goto(url, { timeoutMs });
    return created;
  }

  /** 在现有标签页里找一个 url 以 origin 开头的。 */
  async function findTargetByOrigin(origin) {
    try {
      const res = await fetch(endpoint('/json/list'), { signal: AbortSignal.timeout(4000) });
      if (!res.ok) return null;
      const list = await res.json();
      return list.find((t) => t.type === 'page' && typeof t.url === 'string' && t.url.startsWith(origin)) ?? null;
    } catch {
      return null;
    }
  }

  async function createTarget() {
    // 先建空白页，再由 CDP 导航——比 /json/new?<编码后的 url> 可靠
    for (const method of ['PUT', 'GET']) {
      try {
        const res = await fetch(endpoint('/json/new'), { method });
        if (res.ok) return await res.json();
        if (res.status !== 405) break;
      } catch (error) {
        throw new BrowserUnavailableError(`新建标签页失败：${error.message}`, { port });
      }
    }
    throw new BrowserUnavailableError('新建标签页失败：调试接口拒绝了请求', { port });
  }

  /** 列出当前所有标签页（诊断用）。 */
  async function listTargets() {
    const res = await fetch(endpoint('/json/list'), { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`读取标签页列表失败：HTTP ${res.status}`);
    const list = await res.json();
    return list
      .filter((t) => t.type === 'page')
      .map((t) => ({ id: t.id, url: t.url, title: t.title }));
  }

  async function dispose() {
    for (const page of pages.values()) { try { page.session.close(); } catch { /* noop */ } }
    pages.clear();
  }

  return { port, endpoint, probe, launch, page, listTargets, launcherPath, launchHint, dispose };
}
