# dsh-papersearch · 学术检索

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A522-brightgreen.svg)](package.json)

> GitHub：<https://github.com/waizzie/dsh_papersearch>

让 DSH 里的模型按关键词检索 **Web of Science**、**中国知网（CNKI）**、**arXiv**、**Crossref**，
把不同站点的结果归一化成同一套字段，并**保留后续增加网站的能力**。

- 一个工具跨多个源检索，自动跨源去重（同 DOI / 同标题合并）
- 结果是统一的 `Paper` 记录：标题 / 作者 / 来源出版物 / 年份 / 卷 / 期 / 页 / DOI / 被引 / 摘要 / 链接
- 三种扩展方式：改配置加 JSON API 源、加一个 provider 文件、或从别的插件运行时注册
- 零第三方依赖（Node ≥ 22 自带 `fetch` 与 `WebSocket`）

---

## 一、WoS 为什么走侧栏内嵌窗口

实测结论（本机，2026-10）：

| 站点 | 裸 HTTP 直接请求 | 采用的方案 |
| --- | --- | --- |
| `www.webofscience.com` | SPA 外壳 200，但检索引擎强制要 OnePass 会话 SID | **侧栏面板的内嵌 `<webview>`** + 页面内同源请求 |
| `kns.cnki.net` | 302/403 到 `/verify/home?captchaType=blockPuzzle`（滑块） | 放弃，改用下面的免费入口 |
| `search.cnki.com.cn` | **200，真实结果 HTML，零 cookie 零 referer** | **纯 HTTP**（免登录） |
| `export.arxiv.org` | 200，Atom XML | 纯 HTTP |
| `api.crossref.org` | 200，JSON | 纯 HTTP |

WoS 需要真实浏览器的会话（Cookie + SID），但**不需要在桌面上另开一个 Chrome 窗口**：
DSH 桌面端的侧栏面板里有一个内嵌 `<webview>`，检索请求就在这个窗口的页面上下文里发出，
自动带上站点自己维护的会话状态，既不用破解验证码，也不用把账号密码交给插件。

Host 与面板之间的交接是一个请求队列（`lib/wos-bridge.js`）：

```
paper_search(wos) ──enqueue──▶ Host 队列 ──长轮询──▶ 侧栏面板
                                                    │ 在 <webview> 里同源 fetch
        Host 解释成 Paper ◀──回填原始分片────────────┘
```

面板没打开或没准备好时，`paper_search` 会立刻返回可读原因（**不会回退到外部浏览器**）。
知网、arXiv、Crossref 走纯 HTTP，装完即用、无需任何登录。

> 旧的外部 Chrome 方案（9222 调试端口 + CDP）仍然保留，但默认关闭：
> 只有把配置改成 `wosTransport: cdp` 才会用到它。

---

## 二、安装

### 方式 A：在 DSH 桌面端安装（推荐）

打开 DSH 桌面端的**插件管理页**，选择本目录安装。

> DSH NEXT 的 `desktop` profile 由应用独占管理，请不要在应用外直接对它执行 `dsh plugin`；
> 其它 profile（如 `web`、`tui`）可以用下面的命令行方式。

### 方式 B：命令行安装

```powershell
git clone https://github.com/waizzie/dsh_papersearch.git
dsh plugin --profile <你的 profile> add "<克隆目录的绝对路径>"
```

`dsh plugin add` 会以 `link:` 方式把目录装进 profile，并自动登记到 `dsh.profile.bundles`。
安装后 `paper_*` 工具即可见，无需重启（新 bundle 走 HMR）。替换已安装的旧版本需要重启 DSH。

---

## 三、首次使用：在侧栏准备 WoS 内嵌窗口

> **知网、arXiv、Crossref 不需要这一步**——装完就能直接检索。

1. 打开右侧栏的**「文献检索」**面板；
2. 点 WoS 那一行的**「准备」**，面板会申请一个内嵌浏览器会话并加载 WoS；
3. 等状态变成 **「WoS 内嵌已就绪（检索走侧栏）」**（首次通常 30~40 秒，站点重定向链较长）；
4. 需要机构订阅结果时，点「展开」在内嵌窗口里登录一次（会话记在独立分区里，通常只需做一次）；
5. 之后在面板里检索，或让模型调用 `paper_search`，WoS 都会走这个内嵌窗口。

检查状态：

```
paper_sources
```

它会显示「WoS 通道：侧栏面板已连接」或「未连接」。面板没连上时，
`paper_search` 会提示你打开面板并点「准备」，不会启动任何外部浏览器窗口。

> 访客也能检索：内嵌 WoS 首次调用接口若要求被动验证，面板会自动在页面里真搜一次再重试。

---

## 四、模型工具

| 工具 | 作用 |
| --- | --- |
| `paper_search` | 跨源检索。参数：`query`（必填）、`sources`、`limit`、`year_from`、`year_to`、`sort`（relevance/date/cited）、`with_abstract`、`dedupe`、`export_path` |
| `paper_sources` | 列出所有源、默认源、WoS 面板通道与浏览器状态 |
| `paper_browser` | 默认只有 `status`；`launch` / `open` 需要配置 `allowExternalBrowser: true`（默认关闭） |

导出：给 `paper_search` 传 `export_path: "results.csv"`（也支持 `.json` / `.bib`），
相对路径基于 DSH 进程工作目录，返回绝对路径。

---

## 五、如何新增一个网站

### 方式 A：配置式（不写代码，适合 JSON API）

在 `cordis.patch.yml` 的 `config.sources` 里加一条：

```yaml
- id: dsh-papersearch
  name: 'dsh-papersearch'
  config:
    sources:
      - id: semantic-scholar
        label: Semantic Scholar
        transport: http
        url: 'https://api.semanticscholar.org/graph/v1/paper/search?query={query}&limit={limit}&fields=title,year,venue,authors,externalIds,citationCount,abstract'
        map:
          items: 'data'
          title: 'title'
          authors: 'authors[].name'
          container: 'venue'
          year: 'year'
          citedBy: 'citationCount'
          doi: 'externalIds.DOI'
          abstract: 'abstract'
          url: ''          # 没有就留空，不会编造
```

`url` 支持的占位符：`{query}` `{limit}` `{year_from}` `{year_to}` `{sort}`（自动 URL 编码）。
`map` 的路径语法：`a.b.c` 取嵌套字段，`a[]` 取数组，`a[].b` 摊平取数组每项，`a[0].b` 取下标。
POST 接口用 `method: POST` + `body`（同样支持占位符）+ `headers`。

### 方式 B：代码式（需要站点特殊逻辑，如页面内请求）

在 `lib/providers/` 新建一个文件，导出一个 provider 对象：

```js
import { makePaper } from '../paper.js';

export const mysiteProvider = {
  id: 'mysite',
  label: 'My Site',
  aliases: ['mysite.com'],          // 模型可以用别名调用
  transport: 'browser',             // 'http' 或 'browser'
  loginUrl: 'https://mysite.com/',  // paper_browser 打开这个页面
  note: '需要机构订阅',

  // input: { query, limit, yearFrom, yearTo, sort }
  // ctx:   { browser, log, signal, timeoutMs, config }
  async search({ query, limit }, ctx) {
    const page = await ctx.browser.page('https://mysite.com/search');
    // 关键：在页面上下文里发请求，自动带上该站会话
    const res = await page.inPageFetch(
      `https://mysite.com/api/search?q=${encodeURIComponent(query)}&rows=${limit}`,
      { headers: { accept: 'application/json' } },
    );
    const data = JSON.parse(res.text);
    return {
      items: data.hits.map((hit) => makePaper('mysite', {
        title: hit.title,
        authors: hit.authors,
        container: hit.journal,
        year: hit.year,
        doi: hit.doi,
        url: hit.link,
      })),
    };
  },
};
```

然后在 `lib/providers/index.js` 里加一行：

```js
import { mysiteProvider } from './mysite.js';
// buildProviders() 的数组里加上 mysiteProvider
```

改完重启 DSH（Host 侧模块要重新加载）。

**provider 契约速查**

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | ✓ | 唯一 id，工具参数里用它 |
| `search(input, ctx)` | ✓ | 返回 `{ items, total?, warnings? }`，`items` 必须是 `makePaper()` 的记录 |
| `label` | | 展示名，缺省用 id |
| `aliases` | | 别名数组，模型可用自然说法调用 |
| `transport` | | `'http'`（默认）或 `'browser'` |
| `loginUrl` | | browser 源的落地/登录页 |
| `note` | | 展示给用户的说明（如"需要机构订阅"） |

`makePaper(source, raw)` 会把拿不到的字段填成空串/`null`——**绝不编造**。
单个源抛错不会中断整次检索，错误会作为 `perSource[].error` 返回给模型。

### 方式 C：运行时（别的插件注册）

```js
import { registerProvider } from 'dsh-papersearch';

export function apply(ctx) {
  ctx.effect(() => registerProvider({
    id: 'pubmed',
    label: 'PubMed',
    async search({ query, limit }) { /* ... */ return { items: [] }; },
  }), 'my-plugin: pubmed source');
}
```

---

## 六、源清单

| id | 名称 | 传输 | 说明 |
| --- | --- | --- | --- |
| `cnki` | 中国知网 | http | **免登录**，走 `search.cnki.com.cn` 检索入口；中文文献主力 |
| `arxiv` | arXiv | http | 免登录，预印本（英文学科） |
| `crossref` | Crossref | http | 免登录，DOI 元数据 + 被引数 |
| `wos` | Web of Science | browser | 需登录 / 机构订阅；被引数据较全 |

默认源由 `config.defaultSources` 决定；单个源可以在 `paper_search` 的 `sources` 里指定。

### 各源的实测能力与边界

**知网（`cnki`）** —— 走 `search.cnki.com.cn/search/listresult`（旧版"知网空间"入口）：

- 免登录、免 cookie、免 referer，20 条/页，可直接翻页
- 服务端支持按年过滤（`Year=YYYY`：实测总数从 53104 降到 7549 且结果全为该年），
  所以 `year_from`/`year_to` 是逐年查询，不是抓一堆再本地筛
- 排序：`Order=1` 相关度 / `2` 发表时间 / `3` 被引（实测 Order=3 首条是被引 10360 的综述）
- **拿得到**：标题、作者、刊名、年、期、被引、下载、关键词、摘要片段、文章编号（`data-fn`）
- **拿不到**：DOI、卷号、页码（列表页与详情页都没有）——这些字段一律留空，不编造
- 现代入口 `kns.cnki.net/kns8s/` 对非浏览器请求直接 403 + 滑块验证码，故未采用

**WoS（`wos`）** —— 走新版 SPA 的 `POST /api/wosnx/core/runQuerySearch`：

- 强制要求请求头 `x-1p-wos-sid`；SID 在 `localStorage["wos_sid"]`（值是**带引号的 JSON 字符串**），
  地址栏 `?SID=` 里也有一份
- 匿名请求即使 body 完全正确也返回 `[{key:"error",payload:["Server.sessionNotFound"]}]`，
  **且 HTTP 状态码仍是 200**——插件按 JSON 分片判错，不会把失败当成功
- **访客也能检索**：未登录时首次调用会返回 `Server.passiveVerificationRequired`，
  插件随后在页面里代你真实搜一次（填 Topic + 点 Search），会话即通过验证，然后重试接口
- 站点会把 `www.webofscience.com` 重定向到区域域名（如 `webofscience.clarivate.cn`），
  所以插件按 host 含 `webofscience` 判断，不写死 origin
- 检索字段为 `TS`（主题词），英文关键词效果最好
- `records` 分片的 payload 是**以序号为键的对象**（`{"1":{…}}`），不是数组
- 字段路径已用活体响应核对：`titles.item.en[0].title` / `titles.source.en[0].title` /
  `names.author.en[].wos_standard`（**没有 `display_name`**，且可能含 `null`）/
  `pub_info.{pubyear,vol,issue,page_no}` / `identifiers[type=doi].value` / `doi` /
  `citation_related.counts.WOSCC` / `id.value`（即 UT）/ `abstract.basic.en.abstract`（HTML，已去标签）

---

## 七、已知限制

- **WoS 不需要付费也能搜**，但结果集与机构订阅有关；插件不绕过付费墙，也不破解验证码。
- 知网走的是免费检索入口，**没有 DOI / 卷 / 页码**；需要这些字段请从返回的详情页链接打开。
- 知网结果以期刊为主，学位论文/会议覆盖取决于该入口的收录。
- WoS 首次检索可能触发一次被动验证（面板会自动在内嵌页面里代跑一次检索）；
  若自动触发失败，点「展开」在内嵌窗口里手动搜一次即可。
- **WoS 的检索由侧栏面板执行**：面板没打开或没准备时，`paper_search` 会提示先在侧栏就绪；
  它不会启动外部浏览器，也不会在桌面上弹窗。
- 反爬策略变化可能导致某个源失效——此时该源报错、其它源照常返回，不影响整体检索。
- 相对路径导出以**会话工作目录**为基准；取不到会话目录时请直接传绝对路径。

---

## 八、验证记录（本机实测）

| 项目 | 结果 |
| --- | --- |
| `paper_search` 跨源（cnki + crossref） | 10 条，去重正常，CSV 导出 4295 字节 |
| `paper_search` 跨源（arxiv + crossref） | 10 条，标题/作者/DOI/被引齐全 |
| 知网年份过滤 2020–2022 / 2023–2024 / 2015–2018 | 各 3 条，年份全部落在区间内 |
| 知网被引排序 | 首条《企业数字化转型与资本市场表现》被引 13677 |
| `paper_sources` | 4 个源 + 浏览器状态正确回报 |
| CSV / JSON / BibTeX 导出 | 三种格式均生成且编码正确（CSV 带 BOM，Excel 可直开） |
| **WoS 实检索 `graphrag`** | 命中 **274** 条；取回 10 条，标题/作者/刊名/年卷期页/DOI/被引/摘要全部正确 |
| WoS 访客会话 | 自动跑一次页面内检索通过 `passiveVerificationRequired`，随后接口放行 |
| WoS 侧栏通道 | 内嵌 `<webview>` 完成重定向链并拿到 SID（`webofscience.clarivate.cn/wos/?Func=Frame&…&SID=…`），dom-ready |
| 相对路径导出 | 基准为会话工作目录（此前会落到 Host 进程 cwd，已修） |

---

## 九、目录结构

```
dsh-papersearch/
├─ index.js                 # Host 半：注册工具 + 系统提示 + 源
├─ cordis.patch.yml         # bundle patch（含默认配置与自定义源示例）
├─ lib/
│  ├─ registry.js           # 源注册表（扩展点）
│  ├─ paper.js              # 归一化 Paper 模型、去重、排序
│  ├─ http.js               # 纯 HTTP 传输（超时/重试/UA/XML 取值）
│  ├─ browser.js            # CDP 浏览器引擎（旧通道，默认不用）
│  ├─ wos-bridge.js         # Host ↔ 侧栏面板的 WoS 请求队列
│  ├─ tools.js              # paper_search / paper_sources / paper_browser
│  ├─ format.js             # 结果渲染
│  ├─ export.js             # CSV / JSON / BibTeX 导出
│  ├─ prompt.js             # 系统提示片段
│  └─ providers/
│     ├─ index.js           # 内置源清单（加网站改这里）
│     ├─ wos.js
│     ├─ cnki.js
│     ├─ arxiv.js
│     ├─ crossref.js
│     └─ jsonapi.js         # 配置式 JSON API 适配器
├─ scripts/start-browser.cmd
├─ test/                    # 离线测试（不依赖 DSH）
├─ locale/                  # 中英文展示名
└─ icon.svg
```

---

## 十、测试

```powershell
node test/smoke.mjs "retrieval augmented generation"   # 免登录源 + 渲染 + 三种导出
node test/all-sources.mjs "人工智能"                    # 四源联测（wos 走面板未连接报错路径）
node test/wos-bridge.mjs                               # WoS 面板桥队列语义（离线）
node test/wos-panel-flow.mjs                           # Host 侧面板链路 + 归一化（离线）
node test/browser-offline.mjs                          # 浏览器引擎离线行为
```

---

## 十一、许可

[MIT](LICENSE) © 2026 waizzie

