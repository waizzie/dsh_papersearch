/**
 * 结果导出：CSV / JSON / BibTeX。
 * 路径按 DSH 进程工作目录解析；返回绝对路径，便于用户直接找到文件。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, resolve } from 'node:path';

const CSV_COLUMNS = [
  ['source', '来源'],
  ['title', '标题'],
  ['authors', '作者'],
  ['container', '来源出版物'],
  ['year', '年份'],
  ['volume', '卷'],
  ['issue', '期'],
  ['pages', '页码'],
  ['doi', 'DOI'],
  ['citedBy', '被引'],
  ['url', '链接'],
  ['abstract', '摘要'],
];

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return `"${text.replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
}

export function toCsv(papers) {
  const head = CSV_COLUMNS.map(([, label]) => csvCell(label)).join(',');
  const rows = papers.map((paper) => CSV_COLUMNS
    .map(([key]) => csvCell(key === 'authors' ? (paper.authors ?? []).join('; ') : paper[key]))
    .join(','));
  // BOM 让 Excel 正确识别 UTF-8 中文
  return `\ufeff${[head, ...rows].join('\r\n')}\r\n`;
}

export function toJson(papers) {
  return `${JSON.stringify(papers, null, 2)}\n`;
}

const BIB_TYPES = {
  article: 'article', conference: 'inproceedings', book: 'book',
  chapter: 'incollection', thesis: 'phdthesis', preprint: 'misc',
};

function bibKey(paper, index) {
  const first = (paper.authors?.[0] ?? 'anon').split(/[\s,]+/).filter(Boolean);
  const surname = first[first.length - 1] ?? 'anon';
  const word = (paper.title ?? '').split(/\s+/).find((w) => w.length > 3) ?? 'untitled';
  const clean = (s) => s.replace(/[^A-Za-z0-9\u4e00-\u9fff]/g, '');
  return `${clean(surname).toLowerCase() || 'anon'}${paper.year ?? 'nd'}${clean(word).toLowerCase() || `ref${index}`}`;
}

export function toBibtex(papers) {
  return papers.map((paper, index) => {
    const type = BIB_TYPES[paper.type] ?? 'misc';
    const fields = [
      ['title', paper.title],
      ['author', (paper.authors ?? []).join(' and ')],
      ['journal', paper.type === 'conference' ? '' : paper.container],
      ['booktitle', paper.type === 'conference' ? paper.container : ''],
      ['year', paper.year],
      ['volume', paper.volume],
      ['number', paper.issue],
      ['pages', paper.pages],
      ['doi', paper.doi],
      ['url', paper.url],
      ['note', paper.source === 'arxiv' ? 'arXiv preprint' : ''],
    ]
      .filter(([, value]) => value !== '' && value !== null && value !== undefined)
      .map(([key, value]) => `  ${key} = {${String(value).replace(/[{}]/g, '')}}`);
    return `@${type}{${bibKey(paper, index)},\n${fields.join(',\n')}\n}`;
  }).join('\n\n') + (papers.length > 0 ? '\n' : '');
}

/** 按扩展名选格式并写文件。返回 { path, bytes, format }。 */
export function exportPapers(papers, targetPath, baseDir = '') {
  const absolute = isAbsolute(targetPath)
    ? targetPath
    : resolve(baseDir || process.cwd(), targetPath);
  const ext = extname(absolute).toLowerCase();
  let content;
  let format;
  if (ext === '.json') { content = toJson(papers); format = 'json'; }
  else if (ext === '.bib') { content = toBibtex(papers); format = 'bibtex'; }
  else if (ext === '.csv' || ext === '.tsv' || ext === '') { content = toCsv(papers); format = 'csv'; }
  else throw new Error(`不支持的导出格式：${ext}（支持 .csv / .json / .bib）`);

  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, 'utf8');
  return { path: absolute, bytes: Buffer.byteLength(content, 'utf8'), format };
}
