/** 用真实浏览器 + 新 provider 跑一次检索（绕过插件模块缓存）。 */
import { createBrowserEngine } from '../lib/browser.js';
import { wosProvider } from '../lib/providers/wos.js';
import { renderResults } from '../lib/format.js';

const browser = createBrowserEngine({
  port: 9222,
  packageDir: process.cwd() + '\dsh-papersearch',
  log: (m) => console.log('[engine]', m),
});

const query = process.argv[2] || 'graphrag';
const started = Date.now();
try {
  const out = await wosProvider.search(
    { query, limit: 10, yearFrom: undefined, yearTo: undefined, sort: 'relevance' },
    { browser, log: (m) => console.log('[provider]', m) },
  );
  console.log(`\n耗时 ${Date.now() - started}ms · 命中总数 ${out.total ?? '?'} · 取回 ${out.items.length} 条`);
  if (out.warnings?.length) console.log('warnings:', out.warnings.join('; '));
  console.log('');
  console.log(renderResults({ query, perSource: [{ id: 'wos', label: 'Web of Science', items: out.items }], results: out.items, withAbstract: false }));
} catch (e) {
  console.log(`\n失败（${Date.now() - started}ms）：`, e.message);
}
browser.dispose();
