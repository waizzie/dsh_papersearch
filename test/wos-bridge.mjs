/**
 * 离线测试：WoS 面板桥的队列语义。
 * 用法：node test/wos-bridge.mjs
 */

import { createWosBridge, WosPanelOfflineError } from '../lib/wos-bridge.js';

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures += 1;
};

const bridge = createWosBridge({ defaultTimeoutMs: 3000 });

// 1. 面板没连上时立刻失败
try {
  await bridge.enqueue({ query: 'x' });
  check('offline rejects', false, 'unexpectedly resolved');
} catch (error) {
  check('offline rejects', error instanceof WosPanelOfflineError && error.code === 'PANEL_OFFLINE');
}

// 2. 面板长轮询后算在线；没有任务时等一小会儿返回 null
const idle = await bridge.next({ since: 0, waitMs: 300 });
check('idle long-poll returns null', idle === null);
check('status online after poll', bridge.status().online === true);

// 3. 入队 → 面板取到 → 回填结果
const pending = bridge.enqueue({ query: 'graphrag', limit: 3, sort: 'cited' }, { timeoutMs: 3000 });
const request = await bridge.next({ since: 0, waitMs: 1000 });
check('delivers queued request', Boolean(request) && request.query === 'graphrag' && request.limit === 3 && request.sort === 'cited');
check('request has cursor id', Number.isInteger(request?.id) && request.id > 0);

// 同一请求不会重复派发
const duplicate = await bridge.next({ since: request.id, waitMs: 200 });
check('no duplicate delivery', duplicate === null);

bridge.resolve(request.id, { ok: true, parts: [{ key: 'records', payload: { 1: {} } }] });
const parts = await pending;
check('resolve returns parts', Array.isArray(parts) && parts[0]?.key === 'records');

// 4. 面板回填错误 → Host 侧 reject
const failing = bridge.enqueue({ query: 'x' }, { timeoutMs: 3000 });
const req2 = await bridge.next({ since: request.id, waitMs: 1000 });
bridge.resolve(req2.id, { ok: false, error: '页面没就绪' });
try {
  await failing;
  check('error propagates', false, 'unexpectedly resolved');
} catch (error) {
  check('error propagates', /页面没就绪/.test(error.message));
}

// 5. 超时
const slow = bridge.enqueue({ query: 'slow' }, { timeoutMs: 50 });
await bridge.next({ since: req2.id, waitMs: 500 });
try {
  await slow;
  check('timeout rejects', false, 'unexpectedly resolved');
} catch (error) {
  check('timeout rejects', /超时/.test(error.message));
}

bridge.dispose();
console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
