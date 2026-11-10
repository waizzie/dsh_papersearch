/**
 * 模型可见的检索工具。
 *
 * ctx.tools.register() 的契约：普通对象 + output{schema, render}，
 * 且 `parameters` 必须是带根 type:'object' 的 JSON Schema（原样透传给模型）。
 */

import { dedupe, inYearRange, isUsable, makePaper, sortPapers } from './paper.js';
import { renderResults, sourceLabel } from './format.js';
import { exportPapers } from './export.js';
import { recordSearch } from './panel-store.js';
import { BrowserUnavailableError } from './browser.js';

const OUT = { type: 'object', additionalProperties: true };
const textRender = (fn) => (_args, value) => [{ type: 'text', text: fn(value) }];

/** 属性表 → JSON Schema 对象根。 */
function params(spec) {
  const properties = {};
  const required = [];
  for (const [name, value] of Object.entries(spec ?? {})) {
    const { required: isRequired, ...rest } = value ?? {};
    properties[name] = rest;
    if (isRequired === true) required.push(name);
  }
  return { type: 'object', additionalProperties: false, properties, ...(required.length > 0 ? { required } : {}) };
}

function withTimeout(promise, ms, label) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

/**
 * 解析要检索的源；未知名字进 warnings，不中断整次检索。
 */
export function resolveSources(registry, names, defaults) {
  const requested = Array.isArray(names) && names.length > 0 ? names : defaults;
  const picked = [];
  const warnings = [];
  for (const name of requested ?? []) {
    const provider = registry.resolve(name);
    if (!provider) {
      const available = registry.list().map((p) => p.id).join(' / ');
      warnings.push(`未知的源「${name}」，已跳过（可用：${available || '无'}）`);
      continue;
    }
    if (!picked.some((p) => p.id === provider.id)) picked.push(provider);
  }
  return { picked, warnings };
}

/**
 * 执行一次跨源检索。返回 { perSource, results }。
 * 单个源失败不影响其它源。
 *
 * `precomputed` 允许调用方预先备好某个源的结果（形如 { [providerId]: { items, total, warnings } }）。
 * 侧边栏面板用它把「内嵌 webview 里跑出来的 WoS 结果」塞进来，从而不必启动外部 Chrome。
 */
export async function executeSearch({ registry, settings, browser, query, sources, limit, yearFrom, yearTo, sort, dedupeResults, log, signal, precomputed = {} }) {
  const { picked, warnings } = resolveSources(registry, sources, settings.defaultSources);
  if (picked.length === 0) {
    throw new Error(`没有可用的检索源。${warnings.join('；') || '请在插件配置的 defaultSources 里指定源。'}`);
  }

  const perSource = [];
  const collected = [];

  const runs = picked.map(async (provider) => {
    const started = Date.now();
    const preset = precomputed?.[provider.id];
    if (preset) {
      try {
        const items = (Array.isArray(preset.items) ? preset.items : [])
          .filter(isUsable)
          .filter((paper) => inYearRange(paper, yearFrom, yearTo))
          .slice(0, limit);
        perSource.push({
          id: provider.id,
          label: provider.label,
          count: items.length,
          ms: Date.now() - started,
          warnings: Array.isArray(preset.warnings) ? preset.warnings : [],
        });
        collected.push(...items);
        return items;
      } catch (error) {
        const message = String(error?.message ?? error);
        perSource.push({ id: provider.id, label: provider.label, count: 0, ms: Date.now() - started, error: message });
        return [];
      }
    }
    try {
      const out = await withTimeout(
        provider.search(
          { query, limit, yearFrom, yearTo, sort },
          {
            browser,
            log,
            signal,
            timeoutMs: settings.requestTimeoutMs,
            config: settings,
          },
        ),
        settings.requestTimeoutMs + 15000,
        sourceLabel(provider.id),
      );
      const rawItems = Array.isArray(out?.items) ? out.items : [];
      const items = rawItems
        .map((item) => (item && item.source ? item : makePaper(provider.id, item)))
        .filter(isUsable)
        .filter((paper) => inYearRange(paper, yearFrom, yearTo))
        .slice(0, limit);
      perSource.push({ id: provider.id, label: provider.label, count: items.length, ms: Date.now() - started, warnings: out?.warnings ?? [] });
      collected.push(...items);
      return items;
    } catch (error) {
      const message = error instanceof BrowserUnavailableError
        ? `${error.message}`
        : String(error?.message ?? error);
      perSource.push({ id: provider.id, label: provider.label, count: 0, ms: Date.now() - started, error: message });
      log(`[${provider.id}] 检索失败：${message}`);
      return [];
    }
  });

  await Promise.all(runs);

  // 保持用户指定源的顺序
  perSource.sort((a, b) => picked.findIndex((p) => p.id === a.id) - picked.findIndex((p) => p.id === b.id));

  let results = dedupeResults ? dedupe(collected) : collected;
  results = sortPapers(results, sort);

  return { perSource, results, warnings };
}

export function createTools({ registry, settings, browser, workingDirectory, log = () => {} }) {
  const guard = (exec) => { try { exec?.signal?.throwIfAborted?.(); } catch { /* 已取消 */ } };

  /**
   * 导出用的基准目录：优先当前会话的工作目录（Host 进程的 cwd 可能是 node 安装目录，不可用）。
   */
  const resolveBaseDir = async (exec) => {
    const agent = exec?.agent;
    if (workingDirectory && agent) {
      try {
        const dir = await workingDirectory.ensure(agent, exec?.signal);
        if (dir) return dir;
      } catch { /* 回退到下面的默认值 */ }
    }
    return settings.exportDir || '';
  };

  const tools = [];

  // ── paper_search ───────────────────────────────────────────────────
  tools.push({
    name: 'paper_search',
    description:
      '按关键词在学术数据库里检索论文（Web of Science、中国知网 CNKI、arXiv、Crossref）。'
      + '可一次跨多个源检索并自动去重，返回标题/作者/期刊/年份/卷期页/DOI/被引/链接。'
      + 'WoS 与知网需要用户已登录的浏览器会话（先用 paper_browser 检查），arXiv/Crossref 免登录。',
    parameters: params({
      query: { type: 'string', required: true, description: '检索词。中文源用中文词，英文源用英文词效果最好。' },
      sources: {
        type: 'array',
        items: { type: 'string' },
        description: '要检索的源 id 或别名（如 "wos"、"cnki"、"arxiv"、"crossref"、"知网"、"sci"）。省略则用插件配置的默认源。',
      },
      limit: { type: 'integer', description: '每个源返回条数，默认 10，上限 50。' },
      year_from: { type: 'integer', description: '起始年份（含）。' },
      year_to: { type: 'integer', description: '截止年份（含）。' },
      sort: { type: 'string', enum: ['relevance', 'date', 'cited'], description: '排序：relevance（默认）/ date（新到旧）/ cited（被引多到少）。' },
      with_abstract: { type: 'boolean', description: '是否一并返回摘要（默认 false，省 token）。' },
      dedupe: { type: 'boolean', description: '跨源去重（默认 true）：同 DOI 或同标题只保留一条。' },
      export_path: { type: 'string', description: '可选：把结果写入文件（.csv / .json / .bib），相对路径基于 DSH 进程工作目录。' },
    }),
    output: {
      schema: OUT,
      render: (args, value) => {
        const text = renderResults({
          query: value.query,
          perSource: value.perSource ?? [],
          results: value.results ?? [],
          withAbstract: Boolean(args?.with_abstract),
        });
        const exported = value.exported ? `\n\n已导出 ${value.exported.format.toUpperCase()}：${value.exported.path}（${value.exported.bytes} 字节）` : '';
        return [{ type: 'text', text: text + exported }];
      },
    },
    execute: async (args, exec) => {
      guard(exec);
      const query = String(args.query ?? '').trim();
      if (!query) throw new Error('query 不能为空');
      const limit = Math.min(Math.max(Number(args.limit ?? settings.defaultLimit), 1), 50);
      const yearFrom = Number.isFinite(Number(args.year_from)) && args.year_from !== undefined ? Number(args.year_from) : undefined;
      const yearTo = Number.isFinite(Number(args.year_to)) && args.year_to !== undefined ? Number(args.year_to) : undefined;
      const sort = ['relevance', 'date', 'cited'].includes(args.sort) ? args.sort : 'relevance';

      const { perSource, results, warnings } = await executeSearch({
        registry,
        settings,
        browser,
        query,
        sources: args.sources,
        limit,
        yearFrom,
        yearTo,
        sort,
        dedupeResults: args.dedupe !== false,
        log,
        signal: exec?.signal,
      });

      const trimmed = args.with_abstract === true ? results : results.map((paper) => ({ ...paper, abstract: '' }));
      let exported = null;
      let baseDir = '';
      if (args.export_path) {
        baseDir = await resolveBaseDir(exec);
        if (!baseDir) {
          throw new Error('无法确定导出目录（取不到会话工作目录）。请改用绝对路径，例如 "C:\\\\Users\\\\你\\\\Documents\\\\结果.csv"。');
        }
        exported = exportPapers(results, String(args.export_path), baseDir);
      }

      // 同步给侧边栏面板：模型搜完，用户切到「文献检索」就能看到同一批结果。
      try {
        recordSearch({
          query,
          results: trimmed,
          perSource,
          warnings,
          origin: 'tool',
          baseDir,
          total: trimmed.length,
        });
      } catch { /* 面板缓存失败不影响工具返回 */ }

      return {
        query,
        total: trimmed.length,
        perSource,
        results: trimmed,
        warnings,
        ...(exported ? { exported } : {}),
      };
    },
  });

  // ── paper_sources ──────────────────────────────────────────────────
  tools.push({
    name: 'paper_sources',
    description: '列出当前可用的检索源（id、名称、是否需要登录浏览器、说明），以及浏览器引擎是否就绪。在 paper_search 报"未知源"或需要登录时先调用它。',
    parameters: params({}),
    output: {
      schema: OUT,
      render: (_args, value) => {
        const lines = [`可用源 ${value.sources.length} 个（默认：${(value.defaultSources ?? []).join(', ') || '无'}）`];
        for (const s of value.sources) {
          const need = s.transport === 'browser' ? '需浏览器会话' : '免登录';
          lines.push(`- ${s.id}（${s.label}）· ${need}${s.note ? ` · ${s.note}` : ''}`);
        }
        lines.push('');
        lines.push(value.browser.available
          ? `浏览器引擎：已连接（${value.browser.browser || 'Chrome'}，端口 ${value.browser.port}）`
          : `浏览器引擎：未连接（端口 ${value.browser.port}）— ${value.browser.hint ?? value.browser.message ?? ''}`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    execute: async (_args, exec) => {
      guard(exec);
      const browserStatus = await browser.probe();
      return {
        sources: registry.list().map((p) => ({
          id: p.id,
          label: p.label,
          transport: p.transport,
          note: p.note ?? '',
          aliases: p.aliases ?? [],
          loginUrl: p.loginUrl ?? '',
        })),
        defaultSources: settings.defaultSources,
        browser: browserStatus.available
          ? { available: true, port: browserStatus.port, browser: browserStatus.browser }
          : { available: false, port: browserStatus.port, message: browserStatus.message, hint: browserStatus.hint },
      };
    },
  });

  // ── paper_browser ──────────────────────────────────────────────────
  tools.push({
    name: 'paper_browser',
    description:
      '管理检索用的浏览器会话。action=status 看连接状态；action=launch 尝试启动带调试端口的 Chrome；'
      + 'action=open 打开某个源的页面（用于登录、过验证码）。WoS 与知网必须先有可用会话。',
    parameters: params({
      action: { type: 'string', enum: ['status', 'launch', 'open'], required: true, description: '要执行的操作。' },
      source: { type: 'string', description: 'action=open 时打开哪个源（id 或别名）；也可省略改用 url。' },
      url: { type: 'string', description: 'action=open 时直接指定要打开的网址。' },
    }),
    output: {
      schema: OUT,
      render: (_args, value) => {
        if (value.action === 'status') {
          return [{ type: 'text', text: value.available
            ? `浏览器引擎已就绪：${value.browser || 'Chrome'}（端口 ${value.port}），标签页 ${value.targets?.length ?? 0} 个。`
            : `浏览器引擎未就绪：${value.message ?? ''}\n${value.hint ?? ''}` }];
        }
        if (value.action === 'launch') {
          return [{ type: 'text', text: value.launched
            ? `已启动 Chrome（端口 ${value.port}）。请在打开的窗口里完成登录，再重试检索。`
            : `Chrome 已在运行（端口 ${value.port}），无需重复启动。` }];
        }
        return [{ type: 'text', text: value.url
          ? `已打开 ${value.url}\n请在浏览器窗口里完成登录 / 通过验证码，然后重试 paper_search。`
          : '未打开任何页面' }];
      },
    },
    execute: async (args, exec) => {
      guard(exec);
      const action = String(args.action ?? 'status');
      if (action === 'status') {
        const status = await browser.probe();
        if (!status.available) {
          return { action, available: false, port: status.port, message: status.message, hint: status.hint };
        }
        const targets = await browser.listTargets().catch(() => []);
        return { action, available: true, port: status.port, browser: status.browser, targets };
      }
      if (action === 'launch') {
        const result = await browser.launch({ url: args.url ? String(args.url) : 'about:blank' });
        return { action, launched: result.launched, alreadyRunning: result.alreadyRunning, port: result.port };
      }
      // open
      const url = args.url
        ? String(args.url)
        : (() => {
          const provider = args.source ? registry.resolve(args.source) : null;
          if (!provider) throw new Error(`未知的源「${args.source ?? ''}」，且没有提供 url。`);
          return provider.loginUrl || '';
        })();
      if (!url) throw new Error('该源没有配置 loginUrl，请显式传入 url。');
      const page = await browser.page(url);
      return { action, url: page.url || url, targetId: page.targetId };
    },
  });

  return tools;
}
