/**
 * WoS 面板桥 —— Host 与侧栏面板之间的「WoS 检索由谁执行」交接。
 *
 * 背景：WoS 的会话活在内嵌 <webview>（渲染进程）里，Host 插件拿不到它的 Cookie/SID；
 * 而 Host 自己拉一个外部 Chrome 会在用户桌面上弹窗——这正是要避免的。
 * 所以改成请求队列：
 *
 *   1. Host（paper_search 工具 / 面板接口）enqueue 一条检索请求，等结果；
 *   2. 侧栏面板长轮询 next()，拿到请求后在 webview 里跑同源 fetch；
 *   3. 面板把 WoS 原始分片 resolve() 回 Host，由 Host 统一解释成 Paper。
 *
 * 没有面板连接时**立即失败并给出可读原因**，绝不回退到外部浏览器。
 */

/** 面板多久没长轮询就算掉线。 */
const OFFLINE_AFTER_MS = 20000;

/** 面板没连上时抛这个，方便上层区分「面板没开」和「检索本身失败」。 */
export class WosPanelOfflineError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'WosPanelOfflineError';
    this.code = 'PANEL_OFFLINE';
    this.detail = detail;
  }
}

/**
 * @param {object} [options]
 * @param {number} [options.defaultTimeoutMs] 单次检索的默认超时
 */
export function createWosBridge({ defaultTimeoutMs = 55000 } = {}) {
  /** 单调递增的请求号；面板靠它做 since 游标。 */
  let nextId = 0;
  /** 面板最后一次长轮询的时间。 */
  let lastPollAt = 0;
  /** 已入队、还没被面板取走的请求。 */
  const queue = [];
  /** 已派发给面板、还在等结果的请求。 */
  const inflight = new Map();
  /** 挂起中的长轮询。 */
  const waiters = new Set();

  const now = () => Date.now();

  function clientOnline() {
    return lastPollAt > 0 && now() - lastPollAt < OFFLINE_AFTER_MS;
  }

  /** 按 since 游标取一条待派发请求（同一请求不会重复派发）。 */
  function takeNext(since) {
    while (queue.length > 0) {
      const request = queue.shift();
      if (request.id <= since) continue;
      return request;
    }
    return null;
  }

  function wakeWaiters() {
    if (queue.length === 0) return;
    for (const waiter of [...waiters]) {
      if (queue.length === 0) break;
      waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(takeNext(waiter.since));
    }
  }

  /**
   * Host 侧发起一次 WoS 检索，等面板在内嵌窗口里执行。
   * @param {{query:string, limit?:number, sort?:string, yearFrom?:number, yearTo?:number}} input
   * @param {{timeoutMs?:number, signal?:AbortSignal}} [options]
   * @returns {Promise<Array>} WoS 原始响应分片
   */
  function enqueue(input, { timeoutMs = defaultTimeoutMs, signal } = {}) {
    if (!clientOnline()) {
      return Promise.reject(new WosPanelOfflineError(
        '侧栏「文献检索」面板没有连上，WoS 只能在内嵌窗口里检索。'
        + '请在右侧栏打开「文献检索」面板，点「准备」等 WoS 就绪后再试（不会启动外部浏览器）。',
        { lastPollAt },
      ));
    }

    const id = ++nextId;
    const request = {
      id,
      query: String(input?.query ?? ''),
      limit: Number.isFinite(Number(input?.limit)) ? Number(input.limit) : 10,
      sort: ['relevance', 'date', 'cited'].includes(input?.sort) ? input.sort : 'relevance',
      yearFrom: Number.isFinite(Number(input?.yearFrom)) ? Number(input.yearFrom) : undefined,
      yearTo: Number.isFinite(Number(input?.yearTo)) ? Number(input.yearTo) : undefined,
      at: now(),
    };

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        inflight.delete(id);
        try { signal?.removeEventListener?.('abort', onAbort); } catch { /* noop */ }
        fn(value);
      };

      const timer = setTimeout(() => {
        finish(reject, new Error(
          `内嵌 WoS 检索超时（${Math.round(timeoutMs / 1000)} 秒）。`
          + '请确认侧栏面板里的 WoS 已就绪；必要时点「重试」重新加载内嵌窗口。',
        ));
      }, Math.max(5000, timeoutMs));

      const onAbort = () => finish(reject, new Error('检索已取消'));

      inflight.set(id, {
        resolve: (parts) => finish(resolve, parts),
        reject: (error) => finish(reject, error),
      });

      if (signal) {
        if (signal.aborted) { onAbort(); return; }
        try { signal.addEventListener?.('abort', onAbort, { once: true }); } catch { /* 非标准 signal */ }
      }

      queue.push(request);
      wakeWaiters();
    });
  }

  /**
   * 面板长轮询：有请求立刻返回，没有就挂起最多 waitMs。
   * @param {{since?:number, waitMs?:number}} [options]
   * @returns {Promise<object|null>}
   */
  function next({ since = 0, waitMs = 15000 } = {}) {
    lastPollAt = now();
    const ready = takeNext(since);
    if (ready) return Promise.resolve(ready);
    if (waitMs <= 0) return Promise.resolve(null);

    return new Promise((resolve) => {
      const waiter = { since, resolve };
      waiter.timer = setTimeout(() => {
        waiters.delete(waiter);
        resolve(null);
      }, Math.min(Math.max(waitMs, 1000), 25000));
      waiters.add(waiter);
    });
  }

  /**
   * 面板回填结果。
   * @param {number} id
   * @param {{ok?:boolean, parts?:Array, error?:string}} payload
   */
  function resolve(id, payload = {}) {
    const entry = inflight.get(Number(id));
    if (!entry) return { accepted: false, reason: 'unknown-or-settled' };
    if (payload.ok === false) entry.reject(new Error(String(payload.error || '内嵌 WoS 检索失败')));
    else entry.resolve(Array.isArray(payload.parts) ? payload.parts : [payload.parts]);
    return { accepted: true };
  }

  /** 面板连接状态（给 /sources、paper_sources 用）。 */
  function status() {
    return {
      online: clientOnline(),
      queued: queue.length,
      waiting: inflight.size,
      lastPollAt,
      lastPollAgoMs: lastPollAt ? now() - lastPollAt : null,
    };
  }

  /** 卸载时把还挂着的请求全部失败掉，别让工具调用干等。 */
  function dispose() {
    for (const waiter of waiters) clearTimeout(waiter.timer);
    waiters.clear();
    for (const entry of inflight.values()) entry.reject(new Error('插件已卸载'));
    inflight.clear();
    queue.length = 0;
  }

  return { enqueue, next, resolve, status, dispose };
}
