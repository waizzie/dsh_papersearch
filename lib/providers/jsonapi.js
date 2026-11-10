/**
 * JSON API 适配器 —— 不写代码就加一个网站。
 *
 * 在 config.sources 里声明一条即可：
 *   - id: semantic-scholar
 *     label: Semantic Scholar
 *     transport: http
 *     url: 'https://api.semanticscholar.org/graph/v1/paper/search?query={query}&limit={limit}&fields=title,year,venue,authors,externalIds,citationCount,abstract'
 *     map:
 *       items: 'data'
 *       title: 'title'
 *       authors: 'authors[].name'
 *       container: 'venue'
 *       year: 'year'
 *       citedBy: 'citationCount'
 *       doi: 'externalIds.DOI'
 *       abstract: 'abstract'
 *
 * url 里可用的占位符：{query} {limit} {year_from} {year_to} {sort}（均自动 URL 编码）。
 * map 的取值语法（轻量路径，非完整 JSONPath）：
 *   a.b.c       取嵌套字段
 *   a[]         取数组
 *   a[].b       取数组每项的 b（结果摊平）
 *   a[0].b      取数组第 0 项
 * 也支持 `headers`（对象）与 `method`/`body`（POST 时 body 同样支持占位符）。
 */

import { request } from '../http.js';
import { makePaper } from '../paper.js';

export function getPath(value, path) {
  if (!path) return value;
  return walk(value, String(path).split('.'));
}

function walk(value, tokens) {
  if (tokens.length === 0) return value;
  const [head, ...rest] = tokens;

  const mapMatch = /^(.+)\[\]$/.exec(head);
  if (mapMatch) {
    const arr = value?.[mapMatch[1]];
    if (!Array.isArray(arr)) return [];
    return arr.map((item) => walk(item, rest)).flat().filter((x) => x !== undefined && x !== null);
  }

  const indexMatch = /^(.+)\[(\d+)\]$/.exec(head);
  if (indexMatch) {
    const arr = value?.[indexMatch[1]];
    return walk(arr?.[Number(indexMatch[2])], rest);
  }

  return walk(value?.[head], rest);
}

function fill(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (whole, key) => (
    key in vars && vars[key] !== undefined && vars[key] !== null && vars[key] !== ''
      ? encodeURIComponent(String(vars[key]))
      : whole
  ));
}

const DEFAULT_MAP = {
  items: '',
  title: 'title',
  authors: 'authors',
  container: 'container',
  year: 'year',
  volume: 'volume',
  issue: 'issue',
  pages: 'pages',
  doi: 'doi',
  citedBy: 'citedBy',
  abstract: 'abstract',
  url: 'url',
  type: 'type',
  language: 'language',
};

/** 由配置条目构造一个 provider。 */
export function createJsonApiProvider(definition) {
  const id = String(definition.id ?? '').trim();
  if (!id) throw new Error('config.sources 里的条目缺少 id');
  const map = { ...DEFAULT_MAP, ...(definition.map ?? {}) };
  const method = String(definition.method ?? 'GET').toUpperCase();

  return {
    id,
    label: String(definition.label ?? id),
    aliases: Array.isArray(definition.aliases) ? definition.aliases.map(String) : [],
    transport: 'http',
    note: String(definition.note ?? '自定义源（config.sources 配置）'),

    async search({ query, limit, yearFrom, yearTo, sort }, ctx) {
      const vars = { query, limit, year_from: yearFrom, year_to: yearTo, sort };
      const url = fill(definition.url, vars);
      if (!url || url.includes('{')) {
        throw new Error(`自定义源 ${id} 的 url 模板未正确配置：${definition.url}`);
      }
      const headers = { ...(definition.headers ?? {}) };
      let body;
      if (method !== 'GET') {
        body = definition.body ? fill(definition.body, vars) : undefined;
        if (!headers['content-type'] && !headers['Content-Type']) headers['content-type'] = 'application/json';
      }

      const res = await request(url, { method, headers, body, timeoutMs: ctx.timeoutMs, signal: ctx.signal });
      if (!res.ok) throw new Error(`自定义源 ${id} 返回 HTTP ${res.status}`);
      let data;
      try { data = JSON.parse(res.text); } catch { throw new Error(`自定义源 ${id} 的响应不是 JSON`); }

      const list = getPath(data, map.items);
      const rows = Array.isArray(list) ? list : [list];
      const items = rows
        .map((row) => makePaper(id, {
          sourceId: pick(row, map.sourceId),
          title: pick(row, map.title),
          authors: pick(row, map.authors),
          container: pick(row, map.container),
          year: pick(row, map.year),
          volume: pick(row, map.volume),
          issue: pick(row, map.issue),
          pages: pick(row, map.pages),
          doi: pick(row, map.doi),
          citedBy: pick(row, map.citedBy),
          abstract: pick(row, map.abstract),
          url: pick(row, map.url),
          type: pick(row, map.type),
          language: pick(row, map.language) || 'en',
        }))
        .filter((paper) => paper.title)
        .slice(0, limit);

      return { items };
    },
  };
}

function pick(row, path) {
  if (!path) return '';
  const value = getPath(row, path);
  if (Array.isArray(value)) return value;
  return value ?? '';
}
