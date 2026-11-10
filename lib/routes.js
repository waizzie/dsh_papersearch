/**
 * 供侧边栏面板调用的同源路由。
 *
 *   GET  /dsh-papersearch/api/latest    最近一次检索（工具或面板发起）
 *   GET  /dsh-papersearch/api/sources   可用源 + 浏览器状态 + 导出默认目录
 *   POST /dsh-papersearch/api/search    面板内发起一次检索
 *   POST /dsh-papersearch/api/export    把当前结果导出成文件
 *   POST /dsh-papersearch/api/wos-next  面板长轮询：取一条待执行的 WoS 检索
 *   POST /dsh-papersearch/api/wos-result 面板回填内嵌窗口里跑出来的 WoS 原始分片
 *   GET  /dsh-papersearch/api/wos-status 面板连接状态（诊断用）
 *
 * 安全约定：只接受 loopback Host（与 DSH 自身一致）；只做检索与导出，
 * 不碰用户的其它文件。写文件的目标目录由服务端决定，客户端只能给文件名。
 */

import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import { executeSearch } from './tools.js';
import { exportPapers } from './export.js';
import { interpretWosParts } from './providers/wos.js';
import { recordSearch, readLatest } from './panel-store.js';

const PREFIX = '/dsh-papersearch/api';
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

/** 最近一次内嵌 webview 的能力探测结果（面板上报，供诊断回读）。 */
let lastProbe = null;

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readJsonBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim() === '') { resolve({}); return; }
      try { resolve(JSON.parse(text)); } catch (error) { reject(new Error(`请求体不是合法 JSON：${error.message}`)); }
    });
    req.on('error', reject);
  });
}

/** 导出默认目录：优先发起检索时的会话目录，其次配置，最后下载目录。 */
function defaultExportDir(settings) {
  const latest = readLatest();
  if (latest?.baseDir) return latest.baseDir;
  if (settings.exportDir) return settings.exportDir;
  return join(homedir(), 'Downloads');
}

/**
 * 诊断：本插件的客户端模块有没有进入 Web 启动图（clientModules 服务）。
 * 面板不出现时用它区分「模块没加载」和「加载了但没渲染」。
 * 用 dsh-zotero 做对照组（它的面板在界面上是正常的）。
 */
function clientModuleDiag(ctx) {
  let service;
  try { service = ctx.get('clientModules'); } catch { service = undefined; }
  if (!service) return { hasClientModulesService: false };

  const probe = (id) => {
    const out = { id };
    try { out.clientPath = service.clientPath(id) ?? null; } catch (e) { out.clientPathError = String(e?.message ?? e); }
    try { out.rebuilt = service.rebuilt(id) ?? null; } catch { /* 可选 */ }
    try {
      const baseline = service.artifactBaseline(id);
      out.artifactBaseline = baseline ? Object.keys(baseline) : null;
    } catch { /* 可选 */ }
    return out;
  };

  let graphIds = null;
  let graphError = null;
  try {
    const graph = service.graph();
    // WebBootGraph 形状不对外承诺，宽松取值：优先 modules/clients 数组，退回顶层键
    const list = graph?.modules ?? graph?.clients ?? graph?.entries ?? null;
    if (Array.isArray(list)) {
      graphIds = list.map((row) => (typeof row === 'string' ? row : (row?.id ?? row?.name ?? '?')));
    } else if (graph && typeof graph === 'object') {
      graphIds = Object.keys(graph);
    }
  } catch (e) {
    graphError = String(e?.message ?? e);
  }

  return {
    hasClientModulesService: true,
    self: probe('dsh-papersearch'),
    control: probe('dsh-zotero'),
    inGraph: Array.isArray(graphIds) ? graphIds.includes('dsh-papersearch') : null,
    graphIds,
    graphError,
  };
}

/**
 * 注册面板路由。返回 disposer；webServer 不可用时返回空 disposer（插件其余功能照常）。
 */
export function registerPanelRoutes(ctx, { registry, settings, browser, wosBridge, log = () => {} }) {
  let webServer;
  try { webServer = ctx.get('webServer'); } catch { webServer = undefined; }
  if (!webServer || typeof webServer.register !== 'function') {
    log('webServer 服务不可用：侧边栏面板不会出现（工具检索不受影响）');
    return () => {};
  }

  /** 同一时刻只跑一个面板检索，避免连点把浏览器会话打满。 */
  let inflight = null;

  async function handle(req, res) {
    if (!LOOPBACK_HOST.test(String(req.headers.host ?? ''))) {
      sendJson(res, 403, { ok: false, error: { message: 'forbidden host' } });
      return;
    }

    const url = new URL(req.url ?? '/', 'http://dsh.internal');
    const method = url.pathname.startsWith(`${PREFIX}/`) ? url.pathname.slice(PREFIX.length + 1) : '';

    try {
      // ── 最近一次检索 ──────────────────────────────────────────────
      if (method === 'latest' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, value: readLatest() });
        return;
      }

      // ── 诊断：客户端模块有没有进 Web 启动图 ──────────────────────
      if (method === 'diag' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, value: clientModuleDiag(ctx) });
        return;
      }

      // ── 诊断：内嵌 webview 的能力探测（面板上报，这里回读）────────
      if (method === 'webview-probe' && req.method === 'POST') {
        const body = await readJsonBody(req);
        lastProbe = { at: Date.now(), ...body };
        log(`webview 探测结果：${JSON.stringify(lastProbe).slice(0, 400)}`);
        sendJson(res, 200, { ok: true, value: lastProbe });
        return;
      }
      if (method === 'webview-probe' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, value: lastProbe });
        return;
      }

      // ── WoS 面板桥：面板长轮询取任务 / 回填结果 ───────────────────
      if (method === 'wos-next' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const request = await wosBridge.next({
          since: Number(body.since) || 0,
          waitMs: Number(body.wait) || 15000,
        });
        sendJson(res, 200, { ok: true, value: { request } });
        return;
      }
      if (method === 'wos-result' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const accepted = wosBridge.resolve(Number(body.id), body);
        sendJson(res, 200, { ok: true, value: accepted });
        return;
      }
      if (method === 'wos-status' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, value: wosBridge.status() });
        return;
      }

      // ── 源清单 + 运行状态 ─────────────────────────────────────────
      if (method === 'sources' && req.method === 'GET') {
        const status = await browser.probe();
        sendJson(res, 200, {
          ok: true,
          value: {
            sources: registry.list().map((provider) => ({
              id: provider.id,
              label: provider.label,
              transport: provider.transport,
              note: provider.note ?? '',
            })),
            defaultSources: settings.defaultSources,
            defaultLimit: settings.defaultLimit,
            exportDir: defaultExportDir(settings),
            wos: wosBridge.status(),
            browser: status.available
              ? { available: true, port: status.port, browser: status.browser ?? '' }
              : { available: false, port: status.port, message: status.message ?? '', hint: status.hint ?? '' },
          },
        });
        return;
      }

      // ── 发起检索 ─────────────────────────────────────────────────
      if (method === 'search' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const query = String(body.query ?? '').trim();
        if (!query) throw new Error('检索词不能为空');
        if (inflight) throw new Error('上一次检索还没结束，请稍等');

        const limit = Math.min(Math.max(Number(body.limit ?? settings.defaultLimit), 1), 50);
        const sort = ['relevance', 'date', 'cited'].includes(body.sort) ? body.sort : 'relevance';
        const yearFrom = Number.isFinite(Number(body.yearFrom)) ? Number(body.yearFrom) : undefined;
        const yearTo = Number.isFinite(Number(body.yearTo)) ? Number(body.yearTo) : undefined;

        // 面板可以把「内嵌 webview 里跑出来的 WoS 原始分片」带过来，
        // 这样 WoS 就不必走外部 Chrome + CDP。
        const precomputed = {};
        if (Array.isArray(body.wosParts) && body.wosParts.length > 0) {
          try {
            precomputed.wos = interpretWosParts(body.wosParts, limit);
          } catch (error) {
            precomputed.wos = { items: [], warnings: [String(error?.message ?? error)] };
          }
        }

        // 面板发起的检索里，WoS 必须已经在内嵌窗口跑完（wosParts）；
        // 否则 Host 的 WoS 通道会等面板回填，而面板正等着这次 HTTP 响应 —— 死锁。
        let requestedSources = Array.isArray(body.sources) ? body.sources : undefined;
        if (body.panel === true && !precomputed.wos) {
          const base = requestedSources ?? settings.defaultSources;
          requestedSources = base.filter((id) => String(id).toLowerCase() !== 'wos');
        }
        if (body.panel === true && !precomputed.wos && requestedSources.length === 0) {
          throw new Error('WoS 需要在内嵌窗口里执行：侧栏面板里的 WoS 还没就绪，请先点「准备」，或同时选择其它源。');
        }

        inflight = executeSearch({
          registry,
          settings,
          browser,
          wosBridge,
          query,
          sources: requestedSources,
          limit,
          yearFrom,
          yearTo,
          sort,
          dedupeResults: body.dedupe !== false,
          log,
          precomputed,
        });
        let outcome;
        try { outcome = await inflight; } finally { inflight = null; }

        const latest = recordSearch({
          query,
          results: outcome.results,
          perSource: outcome.perSource,
          warnings: outcome.warnings,
          origin: 'panel',
          total: outcome.results.length,
        });
        sendJson(res, 200, { ok: true, value: latest });
        return;
      }

      // ── 导出 ─────────────────────────────────────────────────────
      if (method === 'export' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const latest = readLatest();
        if (!latest || latest.results.length === 0) throw new Error('没有可导出的结果');

        // 客户端只能给文件名；目录由服务端决定，防止面板被用来写任意路径。
        const raw = String(body.filename ?? '').trim() || `检索结果-${latest.query || 'query'}`;
        const target = basename(raw).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') || `检索结果.${body.ext ?? 'csv'}`;
        const dir = defaultExportDir(settings);

        // 面板里勾选的行优先；没勾就导出全部。
        const picks = Array.isArray(body.indices) && body.indices.length > 0
          ? latest.results.filter((_, index) => body.indices.includes(index))
          : latest.results;

        const exported = exportPapers(picks, target, dir);
        sendJson(res, 200, { ok: true, value: { ...exported, count: picks.length } });
        return;
      }

      sendJson(res, 404, { ok: false, error: { message: `未知接口：${method || '(空)'}` } });
    } catch (error) {
      const message = String(error?.message ?? error);
      log(`面板接口 ${method} 失败：${message}`);
      sendJson(res, 400, { ok: false, error: { message } });
    }
  }

  const dispose = webServer.register({ kind: 'prefix', path: PREFIX, handler: handle });
  log(`面板接口已挂载：${PREFIX}/*`);
  return () => { try { dispose(); } catch { /* 已卸载 */ } };
}
