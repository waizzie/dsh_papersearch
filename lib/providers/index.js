/**
 * 内置源清单 —— 新增网站时，在这里加一行 import + 一行数组元素即可。
 *
 * 顺序即 paper_sources 的展示顺序。
 */

import { wosProvider } from './wos.js';
import { cnkiProvider } from './cnki.js';
import { arxivProvider } from './arxiv.js';
import { crossrefProvider } from './crossref.js';
import { createJsonApiProvider } from './jsonapi.js';

export function buildProviders(settings) {
  const list = [wosProvider, cnkiProvider, arxivProvider, crossrefProvider];

  // 配置里的自定义 JSON API 源（config.sources）
  for (const definition of settings?.sources ?? []) {
    try {
      list.push(createJsonApiProvider(definition));
    } catch (error) {
      // 单条配置错误不应该让整个插件起不来
      // eslint-disable-next-line no-console
      console.warn(`[dsh-papersearch] 自定义源配置无效：${error.message}`);
    }
  }
  return list;
}
