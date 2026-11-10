/**
 * Crossref provider —— 免登录，纯 HTTP，覆盖绝大多数有 DOI 的正式出版物。
 * 与 arXiv 互补：arXiv 给预印本，Crossref 给期刊/会议版本与被引数。
 *
 * API: https://api.crossref.org/swagger-ui/index.html
 */

import { requestJson, stripHtml } from '../http.js';
import { makePaper } from '../paper.js';

export const crossrefProvider = {
  id: 'crossref',
  label: 'Crossref',
  aliases: ['doi', 'crossref.org'],
  transport: 'http',
  note: '免登录，按 DOI 元数据检索；覆盖正式发表的期刊/会议论文，含被引次数。',

  async search({ query, limit, yearFrom, yearTo, sort }, ctx) {
    const params = new URLSearchParams({
      query: String(query),
      rows: String(Math.min(Math.max(limit, 1), 100)),
      select: 'DOI,title,author,container-title,issued,volume,issue,page,is-referenced-by-count,abstract,URL,type',
      sort: sort === 'cited' ? 'is-referenced-by-count' : sort === 'date' ? 'published' : 'relevance',
      order: 'desc',
    });
    const filters = [];
    if (Number.isFinite(yearFrom)) filters.push(`from-pub-date:${yearFrom}-01-01`);
    if (Number.isFinite(yearTo)) filters.push(`until-pub-date:${yearTo}-12-31`);
    if (filters.length > 0) params.set('filter', filters.join(','));
    if (ctx.config?.mailto) params.set('mailto', String(ctx.config.mailto));

    const res = await requestJson(`https://api.crossref.org/works?${params}`, {
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
    });
    const items = res?.message?.items ?? [];
    const papers = items.map(mapItem).filter(Boolean).slice(0, limit);
    return {
      items: papers,
      total: res?.message?.['total-results'],
      warnings: papers.length === 0 ? ['Crossref 未返回匹配结果。'] : [],
    };
  },
};

function mapItem(item) {
  if (!item) return null;
  const title = Array.isArray(item.title) ? item.title[0] : item.title;
  const authors = (item.author ?? [])
    .map((a) => [a.given, a.family].filter(Boolean).join(' ') || a.name || '')
    .filter(Boolean);
  const container = Array.isArray(item['container-title']) ? item['container-title'][0] : item['container-title'];
  const issued = item.issued?.['date-parts']?.[0]?.[0] ?? null;
  return makePaper('crossref', {
    sourceId: item.DOI ?? '',
    title,
    authors,
    container,
    year: issued,
    volume: item.volume,
    issue: item.issue,
    pages: item.page,
    doi: item.DOI,
    citedBy: item['is-referenced-by-count'],
    abstract: item.abstract ? stripHtml(item.abstract) : '',
    url: item.URL || (item.DOI ? `https://doi.org/${item.DOI}` : ''),
    type: mapType(item.type),
    language: 'en',
  });
}

function mapType(type) {
  const map = {
    'journal-article': 'article',
    'proceedings-article': 'conference',
    book: 'book',
    'book-chapter': 'chapter',
    dissertation: 'thesis',
    posted: 'preprint',
  };
  return map[type] ?? (type || 'article');
}
