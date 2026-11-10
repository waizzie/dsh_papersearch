/**
 * 离线集成测试：Host 侧 WoS 面板链路（不启动浏览器、不进 DSH）。
 *
 * 用一个假的「面板」长轮询 bridge，把一条 WoS 分片回填给 Host，
 * 验证 executeSearch 走的是面板通道、结果能正确归一化。
 *
 * 用法：node test/wos-panel-flow.mjs
 */

import { createRegistry } from '../lib/registry.js';
import { executeSearch } from '../lib/tools.js';
import { buildProviders } from '../lib/providers/index.js';
import { createWosBridge } from '../lib/wos-bridge.js';

const settings = {
  defaultSources: ['wos'],
  defaultLimit: 5,
  requestTimeoutMs: 5000,
  sources: [],
  wosTransport: 'panel',
};

const registry = createRegistry();
for (const provider of buildProviders(settings)) registry.register(provider);

const wosBridge = createWosBridge({ defaultTimeoutMs: 5000 });

// 假面板：长轮询取任务，回填一条最小的 records 分片
const fakeParts = [
  {
    key: 'records',
    payload: {
      1: {
        titles: { item: { en: [{ title: 'GraphRAG for Literature Review' }] }, source: { en: [{ title: 'Journal of Tests' }] } },
        names: { author: { en: [{ wos_standard: 'Doe, J.' }] } },
        pub_info: { pubyear: 2025, vol: '12', issue: '3', page_no: '1-9' },
        identifiers: [{ type: 'doi', value: '10.1000/test.1' }],
        citation_related: { counts: { WOSCC: 7 } },
        id: { value: 'WOS:000000000000001' },
        abstract: { basic: { en: { abstract: '<p>An abstract.</p>' } } },
        doctypes: ['Article'],
      },
    },
  },
  { key: 'searchInfo', payload: { RecordsFound: 1 } },
];

let served = 0;
(async () => {
  let since = 0;
  for (;;) {
    const request = await wosBridge.next({ since, waitMs: 1000 });
    if (!request) continue;
    since = request.id;
    served += 1;
    await wosBridge.resolve(request.id, { ok: true, parts: fakeParts });
  }
})();

const { perSource, results } = await executeSearch({
  registry,
  settings,
  browser: { probe: async () => ({ available: false }) },
  wosBridge,
  query: 'graphrag',
  sources: ['wos'],
  limit: 5,
  sort: 'relevance',
  dedupeResults: true,
  log: () => {},
});

const source = perSource.find((s) => s.id === 'wos');
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures += 1;
};

check('panel served one request', served === 1);
check('wos source succeeded', !source?.error, source?.error || '');
check('one paper parsed', results.length === 1);
check('title parsed', results[0]?.title === 'GraphRAG for Literature Review');
check('doi parsed', results[0]?.doi === '10.1000/test.1');
check('citedBy parsed', results[0]?.citedBy === 7);
check('abstract stripped', results[0]?.abstract === 'An abstract.');

// 面板掉线后：立即失败，且提示指向侧栏面板（不回退外部浏览器）
wosBridge.dispose();
const offline = await executeSearch({
  registry,
  settings,
  browser: { probe: async () => ({ available: true, port: 9222 }) },
  wosBridge,
  query: 'x',
  sources: ['wos'],
  limit: 3,
  sort: 'relevance',
  dedupeResults: true,
  log: () => {},
});
const offlineSource = offline.perSource.find((s) => s.id === 'wos');
check('offline fails fast', Boolean(offlineSource?.error));
check('offline message points to sidebar', /面板/.test(offlineSource?.error ?? ''));

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
