/**
 * arXiv provider —— 免登录，纯 HTTP。
 * 作用有二：1) 用户没登录 WoS/知网时也能立刻用；2) 证明"加一个网站"确实只是加一个文件。
 *
 * API: https://info.arxiv.org/help/api/user-manual.html
 */

import { request, stripHtml, xmlTag, xmlTags, decodeXml } from '../http.js';
import { makePaper } from '../paper.js';

const ENDPOINTS = ['https://export.arxiv.org/api/query', 'http://export.arxiv.org/api/query'];

/** 把用户输入变成 arXiv 的查询串：短语加引号，避免被拆成 OR。 */
function buildSearchQuery(query) {
  const text = String(query).trim();
  if (!text) return 'all:*';
  // 已经是字段限定写法（如 au:del_maestro）就原样透传
  if (/\b(all|ti|au|abs|cat|co|jr|rn|id):/i.test(text)) return text;
  const terms = text.split(/\s+/).filter(Boolean);
  if (terms.length === 1) return `all:${terms[0]}`;
  return `all:"${text.replace(/"/g, '')}"`;
}

export const arxivProvider = {
  id: 'arxiv',
  label: 'arXiv',
  aliases: ['arxiv.org', '预印本'],
  transport: 'http',
  note: '免登录，预印本为主（物理/数学/CS/生物），无同行评审版本信息。',

  async search({ query, limit, yearFrom, yearTo, sort }, ctx) {
    const searchQuery = buildSearchQuery(query);
    const sortBy = sort === 'date' ? 'submittedDate' : 'relevance';
    const params = new URLSearchParams({
      search_query: searchQuery,
      start: '0',
      max_results: String(Math.min(Math.max(limit * (yearFrom || yearTo ? 3 : 1), 1), 100)),
      sortBy,
      sortOrder: 'descending',
    });

    let lastError;
    for (const base of ENDPOINTS) {
      try {
        const res = await request(`${base}?${params}`, { timeoutMs: ctx.timeoutMs, signal: ctx.signal });
        if (!res.ok) { lastError = new Error(`arXiv 返回 HTTP ${res.status}`); continue; }
        const items = parseFeed(res.text, { limit, yearFrom, yearTo });
        return { items, warnings: items.length === 0 ? ['arXiv 未返回匹配结果（可尝试更短的关键词或英文表述）。'] : [] };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error('arXiv 检索失败');
  },
};

function parseFeed(xml, { limit, yearFrom, yearTo }) {
  const entries = xmlTags(xml, 'entry');
  const out = [];
  for (const entry of entries) {
    if (out.length >= limit) break;
    const rawId = xmlTag(entry, 'id');
    const arxivId = rawId.replace(/^https?:\/\/arxiv\.org\/abs\//, '').trim();
    const published = xmlTag(entry, 'published');
    const year = published ? Number(published.slice(0, 4)) : null;
    if (Number.isFinite(yearFrom) && (!year || year < yearFrom)) continue;
    if (Number.isFinite(yearTo) && (!year || year > yearTo)) continue;

    const authors = [...entry.matchAll(/<author[^>]*>([\s\S]*?)<\/author>/gi)]
      .map((m) => decodeXml(xmlTag(m[1], 'name')).trim())
      .filter(Boolean);

    const doi = xmlTag(entry, 'arxiv:doi');
    const primary = entry.match(/<arxiv:primary_category[^>]*term="([^"]+)"/i);

    out.push(makePaper('arxiv', {
      sourceId: arxivId,
      title: xmlTag(entry, 'title'),
      authors,
      container: primary ? `arXiv ${primary[1]}` : 'arXiv preprint',
      year,
      doi,
      abstract: stripHtml(xmlTag(entry, 'summary')),
      url: arxivId ? `https://arxiv.org/abs/${arxivId}` : rawId,
      type: 'preprint',
      language: 'en',
    }));
  }
  return out;
}
