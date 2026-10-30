import { toolResult } from '../core/contracts.js';

/**
 * 真实网页搜索（无密钥方案），从 existere2 移植。
 * 优先级：EXISTEON_SEARCH_URL（自定义）→ 中文先百度、英文先 Bing → DuckDuckGo。
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

function strip(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function parseBing(html, limit) {
  const out = [];
  for (const b of String(html || '').split('<li class="b_algo"').slice(1)) {
    if (out.length >= limit) break;
    const a = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(b);
    if (!a) continue;
    if (!/^https?:/.test(a[1])) continue;
    const sn = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(b);
    out.push({ title: strip(a[2]), url: a[1], snippet: strip(sn ? sn[1] : '') });
  }
  return out;
}

function parseBaidu(html, limit) {
  const out = [];
  const re = /<h3[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < limit) {
    let url = m[1];
    if (!/^https?:/.test(url)) continue;
    if (/baidu\.com\/link\?url=/.test(url)) {
      const q = /url=([^&]+)/.exec(url);
      if (q) { try { url = decodeURIComponent(q[1]); } catch { /* keep */ } }
    }
    out.push({ title: strip(m[2]), url, snippet: '' });
  }
  return out;
}

function parseDdg(html, limit) {
  const out = [];
  const re = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && out.length < limit) {
    let url = m[1];
    if (url.startsWith('/l/?')) {
      const q = /uddg=([^&]+)/.exec(url);
      if (q) url = decodeURIComponent(q[1]);
    }
    if (!/^https?:/.test(url)) continue;
    out.push({ title: strip(m[2]), url, snippet: '' });
  }
  return out;
}

async function tryProvider(name, url, parser, limit, timeoutMs) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const results = parser(await res.text(), limit);
    return results.length ? { name, results } : null;
  } catch { return null; }
}

export async function webSearch(query, { limit = 5, timeoutMs = 8000 } = {}) {
  const q = String(query || '').trim();
  if (!q) return toolResult({ ok: false, error: 'query 不能为空' });
  const enc = encodeURIComponent(q);

  const custom = process.env.EXISTEON_SEARCH_URL;
  if (custom) {
    const r = await tryProvider('custom', custom + (custom.includes('?') ? '&' : '?') + 'q=' + enc, (body, n) => {
      try {
        const j = JSON.parse(body);
        return (j.results || []).slice(0, n).map((x) => ({ title: String(x.title || ''), url: String(x.url || ''), snippet: String(x.snippet || '') }));
      } catch { return []; }
    }, limit, timeoutMs);
    if (r) return toolResult({ ok: true, data: { provider: r.name, results: r.results } });
  }

  const bing = () => tryProvider('bing', `https://cn.bing.com/search?q=${enc}&ensearch=0`, parseBing, limit, timeoutMs);
  const baidu = () => tryProvider('baidu', `https://www.baidu.com/s?wd=${enc}`, parseBaidu, limit, timeoutMs);
  const ddg = () => tryProvider('duckduckgo', `https://html.duckduckgo.com/html/?q=${enc}`, parseDdg, limit, timeoutMs);
  const zh = /[\u4e00-\u9fa5]/.test(q);
  for (const run of (zh ? [baidu, bing, ddg] : [bing, ddg, baidu])) {
    const r = await run();
    if (r) return toolResult({ ok: true, data: { provider: r.name, results: r.results } });
  }
  return toolResult({ ok: false, error: '搜索失败：所有搜索源都不可达（网络受限或被反爬）' });
}
