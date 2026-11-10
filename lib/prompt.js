/**
 * 注入系统提示的检索规范。
 * 通过 ctx.systemPrompt.section({ name, order, text }) 注册。
 */

export const PROMPT_SECTION = `## 学术检索（Web of Science / 知网 / arXiv / Crossref）

你可以用 paper_* 工具按关键词检索论文，结果已归一化为同一套字段（标题/作者/期刊/年份/卷期页/DOI/被引/摘要/链接）。

用法约定：
- 检索：paper_search 可一次跨多个源；用 sources 指定源（wos / cnki / arxiv / crossref，或"知网""sci"这类别名），省略则用默认源。
- 先看源状态：paper_search 报"未知源"、或 WoS/知网检索失败时，用 paper_sources 看有哪些源、WoS 面板通道是否连接。
- WoS 通道：WoS 只在侧栏「文献检索」面板的内嵌窗口里执行，不会启动外部浏览器。面板没打开或没准备好时 paper_search 会返回可读原因——转述给用户，请其在右侧栏打开该面板并点「准备」，不要反复重试，也不要建议用户启动外部 Chrome。
- WoS 以英文题录为主：检索 WoS 时用英文关键词（中文检索词通常 0 结果）；中文课题优先用 cnki。
- 导出：需要落盘时给 paper_search 传 export_path（.csv / .json / .bib）。

硬性要求：
1. **不得编造文献**。标题、作者、年份、期刊、DOI、被引数一律来自工具返回；字段缺失就说"该字段缺失"，不要补齐或推测。
2. 引用时注明来源库与 DOI/链接，便于用户回查。
3. 中文课题优先在 cnki 用中文检索，英文课题优先 wos/arxiv/crossref；两边都试时说明差异。
4. 跨源去重默认开启；结果里的"另见 X"表示该文献同时被其它库收录。
5. 检索不到就如实说检索不到，并给出可尝试的调整（换关键词、放宽年份、换源），不要用其它来源冒充该库结果。`;
