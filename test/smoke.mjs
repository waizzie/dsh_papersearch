/**
 * 离线冒烟测试：不装插件、不进 DSH，直接跑注册表 + 免登录源 + 渲染 + 导出。
 * 用法：node test/smoke.mjs "关键词"
 */

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRegistry } from '../lib/registry.js';
import { executeSearch } from '../lib/tools.js';
import { arxivProvider } from '../lib/providers/arxiv.js';
import { crossrefProvider } from '../lib/providers/crossref.js';
import { renderResults } from '../lib/format.js';
import { exportPapers } from '../lib/export.js';

const query = process.argv[2] ?? 'large language model education';

const registry = createRegistry();
registry.register(arxivProvider);
registry.register(crossrefProvider);

const settings = {
  defaultSources: ['arxiv', 'crossref'],
  defaultLimit: 5,
  requestTimeoutMs: 30000,
  sources: [],
};

const browserStub = {
  probe: async () => ({ available: false, port: 9222, message: '冒烟测试未启动浏览器' }),
};

const { perSource, results, warnings } = await executeSearch({
  registry,
  settings,
  browser: browserStub,
  query,
  sources: ['arxiv', 'crossref'],
  limit: 5,
  sort: 'relevance',
  dedupeResults: true,
  log: (m) => console.log('  log:', m),
});

console.log(renderResults({ query, perSource, results, withAbstract: false }));
if (warnings.length > 0) console.log('warnings:', warnings);

const dir = mkdtempSync(join(tmpdir(), 'ps-export-'));
for (const ext of ['csv', 'json', 'bib']) {
  const out = exportPapers(results, join(dir, `out.${ext}`));
  const head = readFileSync(out.path, 'utf8').slice(0, 160).replace(/\s+/g, ' ');
  console.log(`\n[${out.format}] ${out.path} (${out.bytes}B)\n  ${head}`);
}

console.log(`\n结果数：${results.length}；每源：${perSource.map((s) => `${s.id}=${s.error ? 'ERR' : s.count}`).join(' ')}`);
