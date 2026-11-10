/**
 * 把归一化结果渲染成模型可读的紧凑文本。
 * 默认不输出摘要（省 token），需要时由 with_abstract 打开。
 */

const SOURCE_LABEL = { wos: 'WoS', cnki: '知网', arxiv: 'arXiv', crossref: 'Crossref' };

export function sourceLabel(id) {
  return SOURCE_LABEL[id] ?? id;
}

function authorLine(authors) {
  if (!authors || authors.length === 0) return '佚名';
  if (authors.length <= 3) return authors.join(', ');
  return `${authors.slice(0, 3).join(', ')} 等`;
}

/** 单条记录 → 一行文本。 */
export function paperLine(paper, index) {
  const bits = [];
  bits.push(`${index + 1}.`);
  bits.push(`[${sourceLabel(paper.source)}]`);
  bits.push(`${authorLine(paper.authors)} (${paper.year ?? 'n.d.'})`);
  bits.push(paper.title || '(无标题)');
  if (paper.container) bits.push(`— ${paper.container}`);
  if (paper.volume) bits.push(`${paper.volume}${paper.issue ? `(${paper.issue})` : ''}`);
  if (paper.pages) bits.push(`: ${paper.pages}`);
  const meta = [];
  if (paper.doi) meta.push(`DOI ${paper.doi}`);
  if (paper.citedBy !== null) meta.push(`被引 ${paper.citedBy}`);
  if (paper.alsoIn?.length) meta.push(`另见 ${paper.alsoIn.map(sourceLabel).join('/')}`);
  if (meta.length > 0) bits.push(`· ${meta.join(' · ')}`);
  if (paper.url) bits.push(paper.url);
  return bits.join(' ');
}

/** 整批结果 → 文本。 */
export function renderResults({ query, perSource, results, withAbstract }) {
  const lines = [];
  const summary = perSource
    .map((s) => (s.error ? `${sourceLabel(s.id)} ✗` : `${sourceLabel(s.id)} ${s.count}`))
    .join(' · ');
  lines.push(`检索「${query}」：${results.length} 条（${summary}）`);
  for (const [index, paper] of results.entries()) {
    lines.push(paperLine(paper, index));
    if (withAbstract && paper.abstract) {
      lines.push(`   摘要：${paper.abstract.length > 600 ? `${paper.abstract.slice(0, 600)}…` : paper.abstract}`);
    }
  }
  const failed = perSource.filter((s) => s.error);
  const noted = perSource.filter((s) => !s.error && s.warnings?.length > 0);
  if (failed.length > 0 || noted.length > 0) {
    lines.push('');
    for (const s of failed) lines.push(`⚠ ${sourceLabel(s.id)} 失败：${s.error}`);
    for (const s of noted) lines.push(`ℹ ${sourceLabel(s.id)}：${s.warnings.join('；')}`);
  }
  return lines.join('\n');
}
