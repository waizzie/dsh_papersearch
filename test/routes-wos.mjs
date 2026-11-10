/**
 * 离线集成测试：面板 HTTP 接口 + WoS 面板桥（不需要 DSH、不需要浏览器）。
 *
 * 覆盖：
 *   - /sources 回报面板在线状态
 *   - 面板只选 WoS 且没带 wosParts 时快速失败（不会死等自己）
 *   - 工具侧检索：Host 入队 → 面板长轮询取走 → 回填 → 检索返回
 *
 * 用法：node test/routes-wos.mjs
 */

import http from 'node:http';

import { createRegistry } from '../lib/registry.js';
import { buildProviders } from '../lib/providers/index.js';
import { createWosBridge } from '../lib/wos-bridge.js';
import { registerPanelRoutes } from '../lib/routes.js';

const settings = {
  defaultSources: ['wos', 'crossref'],
  defaultLimit: 5,
  requestTimeoutMs: 5000,
  sources: [],
  wosTransport: 'panel',
  allowExternalBrowser: false,
};

const registry = createRegistry();
for (const provider of buildProviders(settings)) registry.register(provider);

const wosBridge = createWosBridge({ defaultTimeoutMs: 8000 });

// 假 webServer：只接 prefix 注册
const handlers = [];
const ctx = {
  get(name) {
    if (name !== 'webServer') return undefined;
    return {
      register(entry) {
        handlers.push(entry.handler);
        return () => {
          const index = handlers.indexOf(entry.handler);
          if (index >= 0) handlers.splice(index, 1);
        };
      },
    };
  },
  logger: { info() {} },
};

const browser = {
  probe: async () => ({ available: false, port: 9222, message: '测试桩：没有外部浏览器' }),
  launch: async () => { throw new Error('测试里不应该启动浏览器'); },
};

const dispose = registerPanelRoutes(ctx, { registry, settings, browser, wosBridge, log: () => {} });

const server = http.createServer((req, res) => {
  for (const handler of handlers) { handler(req, res); return; }
  res.writeHead(404); res.end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/dsh-papersearch/api`;

const call = async (method, body) => {
  const init = body === undefined
    ? { method: 'GET' }
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  const res = await fetch(`${base}/${method}`, init);
  const json = await res.json();
  return { status: res.status, json };
};

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures += 1;
};

// 1. 面板还没连上
const before = await call('sources');
check('/sources wos.online=false', before.json.value.wos.online === false);

// 2. 面板只选 WoS、又没带 wosParts → 立刻 400（不能挂住等自己）
const started = Date.now();
const guarded = await call('search', { query: 'graphrag', panel: true, sources: ['wos'], limit: 3 });
const elapsed = Date.now() - started;
check('panel-only wos fails fast', guarded.status === 400 && elapsed < 3000, `${elapsed}ms`);
check('panel-only wos message mentions 准备', /准备/.test(guarded.json.error?.message ?? ''), guarded.json.error?.message);

// 3. 面板上线：长轮询挂起
const poll = call('wos-next', { since: 0, wait: 5000 });
for (let i = 0; i < 40; i += 1) {
  const status = await call('wos-status');
  if (status.json.value.online) break;
  await new Promise((r) => setTimeout(r, 50));
}
const online = await call('wos-status');
check('panel becomes online after poll', online.json.value.online === true);

// 4. 工具侧检索：Host 入队并等待
const fakeParts = [
  {
    key: 'records',
    payload: {
      1: {
        titles: { item: { en: [{ title: 'Panel Route Paper' }] }, source: { en: [{ title: 'Journal of Routes' }] } },
        names: { author: { en: [{ wos_standard: 'Roe, R.' }] } },
        pub_info: { pubyear: 2024, vol: '1', issue: '2', page_no: '10-20' },
        identifiers: [{ type: 'doi', value: '10.1000/route.1' }],
        citation_related: { counts: { WOSCC: 3 } },
        id: { value: 'WOS:000000000000002' },
        doctypes: ['Article'],
      },
    },
  },
  { key: 'searchInfo', payload: { RecordsFound: 1 } },
];

const searching = call('search', { query: 'graphrag', sources: ['wos'], limit: 3 });
const delivered = await poll;
check('long-poll delivered the queued request', delivered.json.value.request?.query === 'graphrag');
const requestId = delivered.json.value.request?.id;
const posted = await call('wos-result', { id: requestId, ok: true, parts: fakeParts });
check('result accepted', posted.json.value.accepted === true);

const outcome = await searching;
check('search ok', outcome.status === 200 && outcome.json.ok === true);
check('one paper via panel', outcome.json.value?.results?.length === 1, JSON.stringify(outcome.json.value?.perSource));
check('title via panel', outcome.json.value?.results?.[0]?.title === 'Panel Route Paper');

// 5. 面板回填错误 → 检索返回该源错误
const poll2 = call('wos-next', { since: requestId, wait: 5000 });
const searching2 = call('search', { query: 'x', sources: ['wos'], limit: 3 });
const delivered2 = await poll2;
await call('wos-result', { id: delivered2.json.value.request?.id, ok: false, error: '内嵌 WoS 未就绪' });
const outcome2 = await searching2;
const wosSource = outcome2.json.value?.perSource?.find((s) => s.id === 'wos');
check('error surfaces per source', /未就绪/.test(wosSource?.error ?? ''), wosSource?.error);

dispose();
wosBridge.dispose();
await new Promise((resolve) => server.close(resolve));

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
