/**
 * 源注册表 —— "后续增加网站"的落点。
 *
 * 三种扩展方式（从轻到重）：
 *   1. 配置：cordis.patch.yml 的 `config.sources` 里加一条 JSON API 适配器（不用写代码）。
 *   2. 代码：在 lib/providers/ 放一个 provider 文件，并在 lib/providers/index.js 加一行。
 *   3. 运行时：别的插件 `import { registerProvider } from 'dsh-papersearch'` 后注册。
 *
 * provider 契约（全部可选字段都有默认值）：
 * {
 *   id: 'wos',                        // 唯一 id，工具里用这个名字
 *   label: 'Web of Science',          // 展示名
 *   aliases: ['sci', 'webofscience'], // 别名，方便模型用自然说法调用
 *   transport: 'http' | 'browser',    // browser 表示需要用户已登录的浏览器会话
 *   loginUrl: 'https://...',          // browser 源的登录/落地页（paper_browser 用）
 *   note: '需要机构订阅',              // 展示给用户的说明
 *   async search(input, ctx) => ({ items: Paper[], total?, warnings? })
 * }
 *
 * `input` = { query, limit, yearFrom, yearTo, sort }
 * `ctx`   = { http, browser, log, config, signal, timeoutMs }
 * 返回值里的 items 必须是 makePaper() 造出来的归一化记录。
 */

export function createRegistry() {
  const providers = new Map();

  function register(provider, { replace = false } = {}) {
    if (!provider || typeof provider !== 'object') {
      throw new TypeError('provider 必须是对象');
    }
    const id = String(provider.id ?? '').trim();
    if (!id) throw new TypeError('provider.id 不能为空');
    if (typeof provider.search !== 'function') {
      throw new TypeError(`provider "${id}" 缺少 search() 方法`);
    }
    if (providers.has(id) && !replace) {
      throw new Error(`provider "${id}" 已注册，不能重复注册`);
    }
    const normalized = {
      transport: 'http',
      aliases: [],
      label: id,
      note: '',
      loginUrl: '',
      ...provider,
      id,
    };
    providers.set(id, normalized);
    return () => { if (providers.get(id) === normalized) providers.delete(id); };
  }

  function get(id) {
    return providers.get(id);
  }

  /** 把一个名字/别名解析成 provider；解析不到返回 undefined。 */
  function resolve(name) {
    const key = String(name ?? '').trim().toLowerCase();
    if (!key) return undefined;
    if (providers.has(key)) return providers.get(key);
    for (const provider of providers.values()) {
      if (provider.aliases.some((alias) => String(alias).toLowerCase() === key)) return provider;
    }
    return undefined;
  }

  function list() {
    return [...providers.values()];
  }

  function clear() {
    providers.clear();
  }

  return { register, get, resolve, list, clear };
}

/** 进程级单例：让外部插件能共享同一张表。 */
export const sharedRegistry = createRegistry();

/** 供其它插件调用的扩展入口。 */
export function registerProvider(provider) {
  return sharedRegistry.register(provider);
}
