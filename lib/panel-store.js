/**
 * 「最近一次检索」的进程内存储 —— 模型工具与侧边栏面板共用。
 *
 * 为什么需要它：侧边栏面板是独立的前端，拿不到模型那次 paper_search 的返回值。
 * 工具执行完把结果写这里，面板轮询 /dsh-papersearch/api/latest 就能看到同一次检索，
 * 于是「模型搜完 → 侧栏自动出现结果」成立，用户不用再手敲一遍关键词。
 *
 * 只保留最近一次、只保留前 MAX_RESULTS 条：这是展示用的派生缓存，
 * 不是事实来源（会话日志才是）；进程重启后为空，面板会显示空态。
 */

const MAX_RESULTS = 200;

const state = {
  /** 单调递增，供面板判断「有没有新结果」 */
  seq: 0,
  latest: null,
};

/**
 * 记录一次检索。
 * @param {object} entry
 * @param {string} entry.query
 * @param {Array} entry.results
 * @param {Array} [entry.perSource]
 * @param {Array} [entry.warnings]
 * @param {'tool'|'panel'} [entry.origin] 谁发起的
 * @param {string} [entry.baseDir] 发起时的会话工作目录（导出默认落这里）
 * @param {number} [entry.total]
 */
export function recordSearch(entry = {}) {
  const results = Array.isArray(entry.results) ? entry.results.slice(0, MAX_RESULTS) : [];
  state.seq += 1;
  state.latest = {
    seq: state.seq,
    at: Date.now(),
    query: String(entry.query ?? ''),
    results,
    perSource: Array.isArray(entry.perSource) ? entry.perSource : [],
    warnings: Array.isArray(entry.warnings) ? entry.warnings : [],
    origin: entry.origin === 'panel' ? 'panel' : 'tool',
    baseDir: typeof entry.baseDir === 'string' ? entry.baseDir : '',
    total: Number.isFinite(Number(entry.total)) ? Number(entry.total) : results.length,
  };
  return state.latest;
}

/** 读最近一次检索；没有则 null。 */
export function readLatest() {
  return state.latest;
}
