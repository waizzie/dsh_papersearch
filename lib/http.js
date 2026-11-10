/**
 * 纯 HTTP 传输层：给免登录/JSON API 类站点用。
 *
 * 只依赖 Node 内置 fetch。带超时、UA、失败重试与可读错误。
 */

export const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export class HttpError extends Error {
  constructor(message, { status = 0, url = '', body = '' } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

/** 把 AbortSignal（工具 exec.signal）与超时合成一个信号。 */
function combinedSignal(signal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`请求超时（${timeoutMs}ms）`)), timeoutMs);
  const onAbort = () => controller.abort(signal.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    },
  };
}

/**
 * 发一个请求，返回 { status, headers, text }。
 * 4xx/5xx 不抛错（调用方自己判断），网络层失败才抛 HttpError。
 */
export async function request(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = 30000,
    signal,
    retries = 1,
  } = options;

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const { signal: sig, cleanup } = combinedSignal(signal, timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          'user-agent': DESKTOP_UA,
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
          ...headers,
        },
        body,
        signal: sig,
        redirect: 'follow',
      });
      const text = await res.text();
      return { status: res.status, ok: res.ok, headers: res.headers, text, url: res.url || url };
    } catch (error) {
      lastError = error;
      const aborted = sig.aborted;
      if (aborted) break; // 用户取消或超时，不再重试
      if (attempt < retries) await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
    } finally {
      cleanup();
    }
  }
  throw new HttpError(
    `请求失败：${lastError?.message ?? '未知错误'}`,
    { url },
  );
}

/** GET/POST JSON，返回解析后的对象；非 2xx 抛 HttpError。 */
export async function requestJson(url, options = {}) {
  const res = await request(url, {
    ...options,
    headers: { accept: 'application/json', ...(options.headers ?? {}) },
  });
  if (!res.ok) {
    throw new HttpError(`HTTP ${res.status}：${res.url}`, { status: res.status, url: res.url, body: res.text.slice(0, 400) });
  }
  try {
    return JSON.parse(res.text);
  } catch {
    throw new HttpError(`响应不是合法 JSON：${res.url}`, { status: res.status, url: res.url, body: res.text.slice(0, 400) });
  }
}

/** 极简 XML 取值（够用来读 arXiv 的 Atom）。 */
export function xmlTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return match ? decodeXml(match[1]).trim() : '';
}

/** 取某个标签的所有出现。 */
export function xmlTags(xml, tag) {
  const out = [];
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
  let m;
  while ((m = re.exec(xml)) !== null) out.push(decodeXml(m[1]).trim());
  return out;
}

export function decodeXml(text) {
  return String(text)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

/** 粗暴去 HTML 标签 + 反转义，用于把摘要转纯文本。 */
export function stripHtml(html) {
  return decodeXml(String(html ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|tr)>/gi, ' ')
    .replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}
