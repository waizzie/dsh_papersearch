/**
 * dsh-papersearch —— Host 半
 *
 * 让 DSH 里的模型按关键词检索学术数据库（Web of Science / 中国知网 / arXiv / Crossref），
 * 结果归一化成同一套字段返回，并支持不写代码就新增网站。
 *
 * 设计要点：
 * - 源可插拔：lib/providers/ 一个文件 = 一个网站；config.sources 可加 JSON API 源。
 * - WoS / 知网走「用户已登录的浏览器 + 页面内同源 fetch」，因为
 *   知网对非浏览器请求直接下发滑块验证码，纯 HTTP 抓取不可行。
 * - 零第三方依赖（Node >= 22 自带 fetch / WebSocket）。
 */

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sharedRegistry } from './lib/registry.js';
import { createBrowserEngine } from './lib/browser.js';
import { createTools } from './lib/tools.js';
import { registerPanelRoutes } from './lib/routes.js';
import { buildProviders } from './lib/providers/index.js';
import { PROMPT_SECTION } from './lib/prompt.js';

export const name = 'dsh-papersearch';
export const inject = ['tools', 'systemPrompt'];

/** 供其它插件 `import { registerProvider } from 'dsh-papersearch'` 使用。 */
export { registerProvider } from './lib/registry.js';

export function apply(ctx, config = {}) {
  const settings = {
    defaultSources: Array.isArray(config.defaultSources) && config.defaultSources.length > 0
      ? config.defaultSources.map(String)
      : ['wos', 'cnki', 'arxiv', 'crossref'],
    defaultLimit: Number(config.maxResultsPerSource ?? 10),
    requestTimeoutMs: Number(config.requestTimeoutMs ?? 30000),
    sources: Array.isArray(config.sources) ? config.sources : [],
    mailto: config.mailto ? String(config.mailto) : '',
    exportDir: config.exportDir ? String(config.exportDir) : '',
  };

  const log = (msg) => { try { ctx.logger?.info?.(`[dsh-papersearch] ${msg}`); } catch { /* 日志非必需 */ } };

  const browser = createBrowserEngine({
    port: Number(config.browser?.port ?? 9222),
    chromePath: String(config.browser?.chromePath ?? ''),
    profileDir: String(config.browser?.profileDir ?? ''),
    packageDir: packageDir(),
    log,
  });

  // 注册内置源 + 配置里的自定义源（可热重载，故用 replace）
  const disposers = [];
  for (const provider of buildProviders(settings)) {
    try {
      disposers.push(sharedRegistry.register(provider, { replace: true }));
    } catch (error) {
      log(`源 ${provider?.id} 注册失败：${error.message}`);
    }
  }

  ctx.effect(() => {
    const tools = createTools({
      registry: sharedRegistry,
      settings,
      browser,
      workingDirectory: (() => { try { return ctx.get('workingDirectory'); } catch { return undefined; } })(),
      log,
    });
    const cleanups = tools.map((definition) => ctx.tools.register(definition));
    log(`已注册 ${cleanups.length} 个工具，源：${sharedRegistry.list().map((p) => p.id).join(', ')}`);
    return () => { for (const dispose of cleanups) { try { dispose(); } catch { /* noop */ } } };
  }, 'dsh-papersearch: tools');

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'plugin:papersearch',
    order: 41,
    text: PROMPT_SECTION,
  }), 'dsh-papersearch: prompt section');

  // ── 侧边栏面板的同源接口（webServer 是可选服务：没有它插件其余功能照常）──
  const mountRoutes = () => registerPanelRoutes(ctx, {
    registry: sharedRegistry,
    settings,
    browser,
    log,
  });
  const webServerReady = (() => {
    try { return Boolean(ctx.get('webServer')); } catch { return false; }
  })();
  if (webServerReady) {
    ctx.effect(mountRoutes, 'dsh-papersearch: panel routes');
  } else if (typeof ctx.inject === 'function') {
    // webServer 晚于本插件就绪时补挂；服务消失时 cordis 会自动卸载并重跑。
    ctx.inject(['webServer'], () => {
      ctx.effect(mountRoutes, 'dsh-papersearch: panel routes');
    });
  } else {
    log('webServer 不可用：侧边栏面板不会出现（工具检索不受影响）');
  }

  ctx.effect(() => () => {
    for (const dispose of disposers) { try { dispose(); } catch { /* noop */ } }
    browser.dispose();
  }, 'dsh-papersearch: registry cleanup');

  log(`已激活（默认源：${settings.defaultSources.join(', ')}）`);
}

/** 本包目录（用于定位 scripts/start-browser.cmd）。 */
function packageDir() {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return '';
  }
}
