import fs from 'node:fs';
import path from 'node:path';
import { tokensOf } from './index.js';
import { readUtf8 } from '../../core/read.js';

const decay = (ageDays, halfLifeDays) => Math.exp(-Math.max(0, ageDays) / Math.max(1, halfLifeDays));

/**
 * 事实库：不遗忘、可检索的客观事实（人物/地点/日期/参数…）。
 * 写：工具 fact_add；读：Context 与工具 fact_search。
 * 抽取只认显式说法（「记住：…」），不在对话里猜。
 */
export class Facts {
  constructor({ root, halfLifeDays = 180, file } = {}) {
    this.root = root || process.cwd();
    this.halfLifeDays = halfLifeDays;
    this.file = file || path.join(this.root, 'state', 'facts', 'facts.jsonl');
  }

  rows() {
    try {
      return readUtf8(this.file).trim().split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  }

  add({ title = '', content = '', keywords = [], source = '' } = {}) {
    const c = String(content || '').trim();
    if (!c) return { ok: false, error: 'content 不能为空' };
    const row = {
      id: 'fact-' + Date.now().toString(36),
      title: String(title || c.slice(0, 30)),
      content: c,
      keywords: Array.isArray(keywords) ? keywords.map(String) : String(keywords || '').split(/[,，、\s]+/).filter(Boolean),
      source, ts: Date.now(),
    };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, JSON.stringify(row) + '\n');
    } catch (e) { return { ok: false, error: String(e?.message || e) }; }
    return { ok: true, row };
  }

  search(query, { limit = 4, now = Date.now() } = {}) {
    const q = String(query || '').trim();
    if (!q) return [];
    const tokens = tokensOf(q);
    const out = [];
    for (const r of this.rows()) {
      const hay = `${r.title || ''} ${r.content || ''} ${(r.keywords || []).join(' ')}`;
      let n = 0;
      for (const t of tokens) if (hay.includes(t)) n += 1;
      if (!n && !hay.includes(q)) continue;
      const age = ((now - (r.ts || now)) / 86400000);
      out.push({ row: r, score: decay(age, this.halfLifeDays) + 0.05 * n });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, limit).map((x) => x.row);
  }

  /** 显式抽取：「记住：X」「记一下，X」；其它一律不猜。 */
  extract(text) {
    const m = /^(?:请?记住|记一下|要记住|别忘了)[：:，,]\s*(.+)$/.exec(String(text || '').trim());
    if (!m) return null;
    const content = m[1].trim();
    if (content.length < 2) return null;
    return { title: content.slice(0, 30), content, keywords: tokensOf(content).slice(0, 6), source: 'dialog' };
  }
}
