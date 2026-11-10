/**
 * 中国知网（CNKI）provider —— 走 search.cnki.com.cn 的检索入口，纯 HTTP，免登录。
 *
 * 为什么不用 kns.cnki.net：该站对非浏览器请求直接 302/403 到滑块验证码
 * （`/verify/home?captchaType=blockPuzzle`），无浏览器会话无法通过。
 * 而 `search.cnki.com.cn/search/listresult` 实测无需 cookie、无需 referer 即可返回
 * 真实知网文献列表（20 条/页），字段含标题/作者/期刊/年期/摘要片段/被引/下载。
 *
 * 契约（实测）：
 *   POST https://search.cnki.com.cn/search/listresult
 *   form: searchType=QuickSearch&Theme=<关键词>&Page=<n>&Order=<1|2|3>
 *   Order: 1=相关度 2=发表时间 3=被引
 *   返回 HTML，结果在 <div class="list-item">，总数在 $("#totalcount").html("N")
 *
 * 限制：列表页不提供 DOI、页码、卷号；需要这些字段请到详情页或改用 kns 总库。
 */

import { request, stripHtml } from '../http.js';
import { makePaper } from '../paper.js';

const ENDPOINT = 'https://search.cnki.com.cn/search/listresult';
const PER_PAGE = 20;

const ORDER = { relevance: '1', date: '2', cited: '3' };

export const cnkiProvider = {
  id: 'cnki',
  label: '中国知网',
  aliases: ['知网', 'cnki.net', 'cnki', '中国知网'],
  transport: 'http',
  loginUrl: 'https://search.cnki.com.cn/',
  note: '免登录（知网空间检索入口）；列表页无 DOI/页码，中文文献主力。',

  async search({ query, limit, yearFrom, yearTo, sort }, ctx) {
    const order = ORDER[sort] ?? ORDER.relevance;
    const collected = [];
    let total = null;
    let lastWarning = '';

    const yearOk = (paper) => {
      if (!Number.isFinite(yearFrom) && !Number.isFinite(yearTo)) return true;
      if (paper.year === null) return false;
      if (Number.isFinite(yearFrom) && paper.year < yearFrom) return false;
      if (Number.isFinite(yearTo) && paper.year > yearTo) return false;
      return true;
    };

    // 该入口支持服务端按年过滤（Year=YYYY，实测：总数从 53104 降到 7549 且结果全为该年）。
    // 年份区间就逐年查；区间过宽或无下界时退回客户端过滤。
    const years = planYears(yearFrom, yearTo);
    const fetcher = async (extra) => {
      const body = new URLSearchParams({
        searchType: 'QuickSearch',
        Theme: String(query),
        Content: String(query),
        Page: String(extra.page ?? 1),
        page: String(extra.page ?? 1),
        Order: order,
        ArticleType: '',
        ...(extra.year ? { Year: String(extra.year) } : {}),
      }).toString();

      const res = await request(ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
          accept: 'text/html, */*; q=0.01',
          referer: 'https://search.cnki.com.cn/',
        },
        body,
        timeoutMs: ctx.timeoutMs,
        signal: ctx.signal,
      });

      if (!res.ok) throw new Error(`知网返回 HTTP ${res.status}（${ENDPOINT}）`);
      if (/verify\/home|captchaType=/.test(res.text.slice(0, 800))) {
        throw new Error('知网要求验证码验证，本次请求被拦截。请稍后重试，或改用 paper_browser 打开知网页面。');
      }
      return parsePage(res.text);
    };

    if (years.length > 0) {
      for (const year of years) {
        if (collected.length >= limit) break;
        const pages = Math.max(1, Math.ceil(limit / PER_PAGE));
        for (let page = 1; page <= pages; page += 1) {
          const parsed = await fetcher({ year, page });
          if (total === null && parsed.total !== null) total = parsed.total;
          if (parsed.items.length === 0) break;
          for (const paper of parsed.items) {
            if (yearOk(paper)) collected.push(paper);
          }
          if (collected.length >= limit) break;
          if (parsed.total !== null && page * PER_PAGE >= parsed.total) break;
        }
      }
    } else {
      const maxPages = Math.min(Math.ceil(limit / PER_PAGE) + 1, 3);
      for (let page = 1; page <= maxPages && collected.length < limit; page += 1) {
        const parsed = await fetcher({ page });
        if (total === null && parsed.total !== null) total = parsed.total;
        if (parsed.items.length === 0) {
          if (page === 1) lastWarning = '知网未返回匹配结果（可换更通用的中文关键词）。';
          break;
        }
        for (const paper of parsed.items) {
          if (yearOk(paper)) collected.push(paper);
        }
        if (parsed.total !== null && page * PER_PAGE >= parsed.total) break;
      }
    }

    if (collected.length === 0 && !lastWarning) {
      lastWarning = `知网在该年份区间（${yearFrom ?? '不限'}–${yearTo ?? '不限'}）内未命中，可放宽年份或换关键词。`;
    }

    return {
      items: collected.slice(0, limit),
      total: total ?? undefined,
      warnings: lastWarning ? [lastWarning] : [],
    };
  },
};

/**
 * 决定用哪些年份做服务端过滤。
 * 返回 [] 表示不做服务端过滤（由调用方客户端过滤）。
 */
export function planYears(yearFrom, yearTo) {
  const hasFrom = Number.isFinite(yearFrom);
  const hasTo = Number.isFinite(yearTo);
  const thisYear = new Date().getFullYear();
  if (!hasFrom && !hasTo) return [];

  const to = hasTo ? yearTo : thisYear;
  const from = hasFrom ? yearFrom : to;
  if (to < from) return [];
  const span = to - from + 1;
  if (span > 10) return []; // 区间过宽，逐年查代价太大

  const years = [];
  for (let year = to; year >= from; year -= 1) years.push(year);
  return years;
}

// ── HTML 解析 ────────────────────────────────────────────────────────

const clean = (html) => stripHtml(html).replace(/\u00a0/g, ' ').trim();

export function parsePage(html) {
  const totalMatch = html.match(/\$\("#totalcount"\)\.html\("(\d+)"\)/);
  const total = totalMatch ? Number(totalMatch[1]) : null;

  const items = [];
  // checkbox1 的 data-fn 是每条记录（文章编号）的稳定边界
  const re = /<div class="list-item">([\s\S]*?)<div class="checkbox1"[^>]*data-fn="([^"]*)"/g;
  let match;
  while ((match = re.exec(html)) !== null) {
    const paper = parseItem(match[1], match[2]);
    if (paper) items.push(paper);
  }
  return { total, items };
}

function parseItem(block, articleCode) {
  const titleAnchor = block.match(/<a href="([^"]+)"[^>]*class="left"[^>]*title="([^"]*)"/);
  if (!titleAnchor) return null;
  const link = titleAnchor[1];
  const title = clean(titleAnchor[2]);
  if (!title) return null;

  const sourceBlock = block.match(/<p class="source">([\s\S]*?)<\/p>/)?.[1] ?? '';
  // 作者只在第一个 /cjfd/Detail 链接之前；之后是期刊/年期，再往后是关键词
  const authorZone = sourceBlock.split('/cjfd/Detail')[0];
  const authors = [...authorZone.matchAll(/data-key="([^"]+)"/g)]
    .map((m) => clean(m[1]))
    .filter((name) => name && !name.includes('/'));

  const detailAnchors = [...sourceBlock.matchAll(/<a href="\/cjfd\/Detail[^"]*"[^>]*>([\s\S]*?)<\/a>/g)]
    .map((m) => clean(m[1]));
  const journal = (detailAnchors[0] ?? '').replace(/^《|》$/g, '').trim();
  const issueText = detailAnchors[1] ?? '';

  const yearMatch = issueText.match(/(\d{4})年/);
  const issueMatch = issueText.match(/\d{4}年\s*(\d+)期/);
  const typeLabel = sourceBlock.match(/<span>\s*([^<]{1,8}?)\s*<\/span>\s*$/)?.[1] ?? '';

  const abstract = clean(block.match(/<p class="nr">([\s\S]*?)<\/p>/)?.[1] ?? '');
  const citedMatch = block.match(/被引[（(]\s*(\d+)\s*[）)]/);

  return makePaper('cnki', {
    sourceId: clean(articleCode),
    title,
    authors,
    container: journal,
    year: yearMatch ? Number(yearMatch[1]) : null,
    issue: issueMatch ? issueMatch[1] : '',
    citedBy: citedMatch ? Number(citedMatch[1]) : null,
    abstract: abstract.replace(/\.\.\.$/, ''),
    url: link.startsWith('//') ? `https:${link}` : link,
    type: mapType(typeLabel),
    language: 'zh',
  });
}

function mapType(label) {
  if (!label) return 'article';
  if (/博士|硕士|学位/.test(label)) return 'thesis';
  if (/会议/.test(label)) return 'conference';
  if (/报纸/.test(label)) return 'newspaper';
  if (/年鉴/.test(label)) return 'book';
  if (/专利/.test(label)) return 'patent';
  return 'article';
}
