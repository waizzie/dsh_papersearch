/**
 * 归一化文献记录（Paper）。
 *
 * 所有 provider 都必须把各自站点的原始结果映射成这个形状，工具层只认这个形状。
 * 新增一个网站 = 新增一个 provider 文件，把它的字段映射到下面这些键上。
 */

/** 记录字段（顺序即展示顺序）。 */
export const PAPER_FIELDS = [
  'title', 'authors', 'container', 'year', 'volume', 'issue', 'pages',
  'doi', 'citedBy', 'abstract', 'url', 'type', 'language', 'sourceId',
];

/** 各字段的默认值；provider 拿不到的字段一律保持默认，绝不编造。 */
export function makePaper(source, raw = {}) {
  const authors = Array.isArray(raw.authors)
    ? raw.authors.map((a) => String(a ?? '').trim()).filter(Boolean)
    : [];
  const year = Number.parseInt(raw.year, 10);
  const citedBy = Number.isFinite(Number(raw.citedBy)) ? Number(raw.citedBy) : null;
  return {
    source: String(source),
    sourceId: str(raw.sourceId),
    title: str(raw.title),
    authors,
    container: str(raw.container),
    year: Number.isFinite(year) && year > 1000 && year < 2200 ? year : null,
    volume: str(raw.volume),
    issue: str(raw.issue),
    pages: str(raw.pages),
    doi: normDoi(raw.doi),
    citedBy,
    abstract: str(raw.abstract),
    url: str(raw.url),
    type: str(raw.type) || 'article',
    language: str(raw.language),
  };
}

function str(value) {
  if (value === null || value === undefined) return '';
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text === 'null' || text === 'undefined' ? '' : text;
}

/** DOI 统一成裸 DOI（去掉 https://doi.org/ 前缀）。 */
export function normDoi(value) {
  const text = str(value);
  if (!text) return '';
  return text.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '').trim();
}

/** 一条记录是否"有内容"——只有标题才算数，空壳直接丢弃。 */
export function isUsable(paper) {
  return Boolean(paper && paper.title && paper.title.length > 1);
}

/** 按年份区间过滤。 */
export function inYearRange(paper, yearFrom, yearTo) {
  if (!Number.isFinite(yearFrom) && !Number.isFinite(yearTo)) return true;
  if (paper.year === null) return false; // 无年份的记录在限定年份时无法判定，剔除
  if (Number.isFinite(yearFrom) && paper.year < yearFrom) return false;
  if (Number.isFinite(yearTo) && paper.year > yearTo) return false;
  return true;
}

const normTitle = (t) => t.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');

/**
 * 跨源去重：优先按 DOI，其次按规范化标题。保留先出现的一条，
 * 并把被合并条目的 source 记到 `alsoIn` 上，方便模型知道多库都收录了。
 */
export function dedupe(papers) {
  const byDoi = new Map();
  const byTitle = new Map();
  const out = [];
  for (const paper of papers) {
    const doi = paper.doi ? paper.doi.toLowerCase() : '';
    const title = paper.title ? normTitle(paper.title) : '';
    const hit = (doi && byDoi.get(doi)) || (title && byTitle.get(title)) || null;
    if (hit) {
      if (!hit.alsoIn.includes(paper.source)) hit.alsoIn.push(paper.source);
      // 补齐主记录缺失的字段（不做覆盖，避免低质量源污染）
      for (const key of PAPER_FIELDS) {
        if (!hit[key] && paper[key]) hit[key] = paper[key];
      }
      continue;
    }
    paper.alsoIn = [];
    out.push(paper);
    if (doi) byDoi.set(doi, paper);
    if (title) byTitle.set(title, paper);
  }
  return out;
}

const SORTERS = {
  relevance: null, // 保持各源返回顺序（源内部已按相关度排）
  date: (a, b) => (b.year ?? 0) - (a.year ?? 0),
  cited: (a, b) => (b.citedBy ?? -1) - (a.citedBy ?? -1),
};

/** 稳定排序；`relevance` 表示不动。 */
export function sortPapers(papers, mode = 'relevance') {
  const fn = SORTERS[mode];
  if (!fn) return papers;
  return [...papers].sort(fn);
}
