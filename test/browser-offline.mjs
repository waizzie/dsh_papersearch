/**
 * 浏览器引擎的失败路径测试：端口未开时应给出可读、可操作的错误。
 *
 * 刻意用一个没人监听的端口（9223）+ 不存在的 chromePath，
 * 这样测试**绝不会**真的拉起 Chrome 窗口。
 */
import { createBrowserEngine, BrowserUnavailableError } from '../lib/browser.js';

const engine = createBrowserEngine({
  port: 9223,
  chromePath: 'C:\\__dsh-papersearch-test__\\chrome.exe',
  packageDir: process.cwd(),
  log: (m) => console.log('log:', m),
});

const status = await engine.probe();
console.log('probe ->', JSON.stringify(status, null, 2));
console.log('launcherPath ->', engine.launcherPath());

try {
  await engine.page('https://www.webofscience.com/');
  console.log('page() 意外成功');
} catch (error) {
  console.log('page() 抛出 ->', error.name, '|', error.message);
  console.log('是 BrowserUnavailableError:', error instanceof BrowserUnavailableError);
}

try {
  await engine.launch({ url: 'about:blank' });
  console.log('launch() 意外成功');
} catch (error) {
  console.log('launch() 抛出 ->', error.name, '|', error.message.slice(0, 200));
}
