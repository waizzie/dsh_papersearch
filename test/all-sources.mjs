/**
 * 四源联测：cnki（免登录 HTTP）+ arxiv + crossref 真实检索，wos 走「面板未连接」报错路径。
 * 用法：node test/all-sources.mjs "关键词"
 */

import { createRegistry } from '../lib/registry.js';
import { executeSearch } from '../lib/tools.js';
import { buildProviders } from '../lib/providers/index.js';
import { renderResults } from '../lib/format.js';
import { createBrowserEngine } from '../lib/browser.js';

const query = process.argv[2] ?? '人工智能';

const settings = {
  defaultSources: ['cnki', 'arxiv', 'crossref', 'wos'],
  defaultLimit: 5,
  requestTimeoutMs: 30000,
  sources: [],
};

const registry = createRegistry();
for (const provider of buildProviders(settings)) registry.register(provider);
console.log('已注册源：', registry.list().map((p) => `${p.id}(${p.transport})`).join(', '));

const browser = createBrowserEngine({ port: 9222, packageDir: process.cwd() + '\\dsh-papersearch' });

// WoS 现在只走侧栏面板的内嵌窗口；离线测试用一个「面板未连接」的桩
const wosBridge = {
  async enqueue() { throw new Error('侧栏「文献检索」面板没有连上（离线测试桩）'); },
  status: () => ({ online: false }),
};

console.log('\n========== 免登录三源 ==========');
const free = await executeSearch({
  registry,
  settings,
  browser,
  query,
  sources: ['cnki', 'arxiv', 'crossref'],
  limit: 4,
  sort: 'relevance',
  dedupeResults: true,
  log: (m) => console.log('  log:', m),
});
console.log(renderResults({ query, perSource: free.perSource, results: free.results, withAbstract: false }));

console.log('\n========== 知网单独看字段完整度 ==========');
const cnkiOnly = await executeSearch({
  registry, settings, browser, query,
  sources: ['cnki'], limit: 3, sort: 'cited', dedupeResults: false,
  log: () => {},
});
for (const p of cnkiOnly.results) console.log(JSON.stringify(p, null, 1));

console.log('\n========== 知网年份过滤 2020-2022 ==========');
const yf = await executeSearch({
  registry, settings, browser, query,
  sources: ['cnki'], limit: 3, yearFrom: 2020, yearTo: 2022, sort: 'relevance', dedupeResults: false,
  log: () => {},
});
console.log(yf.results.map((p) => `${p.year} ${p.title}`).join('\n') || '(无)');

console.log('\n========== wos 面板未连接时的报错 ==========');
const wos = await executeSearch({
  registry, settings, browser, wosBridge, query,
  sources: ['wos'], limit: 3, sort: 'relevance', dedupeResults: false,
  log: () => {},
});
console.log(JSON.stringify(wos.perSource, null, 1));
