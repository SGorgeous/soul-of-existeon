import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readUtf8 } from '../../core/read.js';

/** 关键词切分：英文词 + 中文二元组（够召回，不需要分词器）。 */
export function tokensOf(text) {
  const s = String(text || '').trim();
  if (!s) return [];
  const set = new Set();
  for (const t of s.split(/[\s,，。.!?;；:：、（）()\[\]{}"'“”‘’/\\|]+/)) {
    if (t.length >= 2 && !/^[\u3400-\u9fff]+$/.test(t)) set.add(t);
  }
  for (const m of s.matchAll(/[\u3400-\u9fff]{2,}/g)) {
    const run = m[0];
    if (run.length <= 8) set.add(run);
    for (let i = 0; i + 2 <= run.length; i += 1) set.add(run.slice(i, i + 2));
  }
  return [...set].slice(0, 24);
}

const decay = (ageDays, halfLifeDays) => Math.exp(-Math.max(0, ageDays) / Math.max(1, halfLifeDays));

/**
 * 记忆：主观记忆（state/memory.jsonl）+ 可选读 DSH 记忆库（~/.dsh/memory/*.md）。
 * 召回 = 关键词命中 × 重要性 × 遗忘曲线；不是全文检索。
 */
export class Memory {
  constructor({ root, providers = ['self', 'dsh'], halfLifeDays = 30, dshDir, file } = {}) {
    this.root = root || process.cwd();
    this.providers = providers;
    this.halfLifeDays = halfLifeDays;
    this.file = file || path.join(this.root, 'state', 'memory.jsonl');
    this.dshDir = dshDir || path.join(os.homedir(), '.dsh', 'memory');
    this._dshCache = null;
    this._dshAt = 0;
  }

  rows() {
    try {
      return readUtf8(this.file).trim().split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter((r) => r && r.text);
    } catch { return []; }
  }

  /** 统一格式：不管从哪来的，存进去都是这一套字段 */
  static normalize(row = {}) {
    const text = String(row.text || '').trim();
    if (!text) return null;
    const kwIn = Array.isArray(row.keywords) ? row.keywords : String(row.keywords || '').split(/[,，、\s]+/);
    const junk = new Set(['true', 'false', 'null', 'undefined', 'nan']);
    const kw = [...new Set(kwIn.map((k) => String(k).trim()).filter((k) => k && !junk.has(k.toLowerCase())))].slice(0, 12);
    const clamp = (n) => Math.max(0, Math.min(1, Number.isFinite(Number(n)) ? Number(n) : 0.5));
    const out = {
      id: String(row.id || '').trim() || null,
      text,
      keywords: kw,
      salience: clamp(row.salience),
      ts: Number(row.ts) || Date.now(),
      source: String(row.source || 'self').trim().slice(0, 24) || 'self',
    };
    if (row.core === true) out.core = true;
    return out;
  }

  /** 卡片视图用：全部行（规范化，缺 id 的补一个，但不写盘） */
  cards() {
    return this.rows().map((r, i) => {
      const n = Memory.normalize(r);
      if (!n) return null;
      n.id = n.id || `m-${i.toString(36)}-${String(n.ts).slice(-5)}`;
      return n;
    }).filter(Boolean);
  }

  /** 整表写回（卡片保存就调它）；同一套规范化，行的顺序不变 */
  writeRows(rows = []) {
    const list = [];
    for (const r of rows) {
      const n = Memory.normalize(r);
      if (!n) continue;
      if (!n.id) n.id = 'm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
      list.push(n);
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, list.map((r) => JSON.stringify(r)).join('\n') + (list.length ? '\n' : ''));
      fs.renameSync(tmp, this.file);
    } catch (e) { return { ok: false, error: String(e?.message || e) }; }
    return { ok: true, count: list.length, core: list.filter((r) => r.core).length };
  }

  write({ text, keywords = [], salience = 0.5, source = 'self', core = false, ts = null } = {}) {
    const t = String(text || '').trim();
    if (!t) return { ok: false, error: 'text 不能为空' };
    const row = Memory.normalize({ text: t, keywords, salience, source, core, ts });
    if (!row) return { ok: false, error: 'text 不能为空' };
    row.id = 'm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, JSON.stringify(row) + '\n');
    } catch (e) { return { ok: false, error: String(e?.message || e) }; }
    return { ok: true, row };
  }

  /** 核心记忆：不靠线索也会一直在心里（上下文里永远带上前几条） */
  coreRows(limit = 6) {
    return this.rows().filter((r) => r.core).sort((a, b) => (b.salience || 0) - (a.salience || 0)).slice(0, limit);
  }

  /** DSH 记忆库：按段落切块，30 秒缓存。 */
  dshChunks() {
    const now = Date.now();
    if (this._dshCache && now - this._dshAt < 30000) return this._dshCache;
    const out = [];
    try {
      const files = fs.readdirSync(this.dshDir).filter((f) => f.endsWith('.md')).slice(0, 200);
      for (const f of files) {
        const full = path.join(this.dshDir, f);
        const stat = fs.statSync(full);
        const text = readUtf8(full);
        for (const block of text.split(/\n\s*\n+/)) {
          const b = block.replace(/^#+\s*/, '').trim();
          if (b.length < 8) continue;
          out.push({ text: b.slice(0, 600), mtime: stat.mtimeMs, file: f });
        }
      }
    } catch { /* 没有 DSH 记忆库 */ }
    this._dshCache = out;
    this._dshAt = now;
    return out;
  }

  recall(query, { limit = 5, now = Date.now() } = {}) {
    const q = String(query || '').trim();
    if (!q) return [];
    const tokens = tokensOf(q);
    const hits = [];
    const hitScore = (hay, kw) => {
      const h = String(hay || '');
      let n = 0;
      for (const t of tokens) if (h.includes(t)) n += 1;
      if (kw && String(kw).includes(q)) n += 1;
      return n;
    };

    if (this.providers.includes('self')) {
      for (const r of this.rows()) {
        const n = hitScore(r.text, (r.keywords || []).join(' '));
        if (!n) continue;
        const age = ((now - (r.ts || now)) / 86400000);
        // 核心记忆几乎不忘：不按半衰期衰减
        const base = r.core ? 1 : decay(age, this.halfLifeDays);
        const score = base * (Number(r.salience) || 0.5) + 0.05 * n;
        hits.push({ text: r.text, source: 'self', score, ts: r.ts || null, core: !!r.core });
      }
    }

    if (this.providers.includes('dsh')) {
      for (const c of this.dshChunks()) {
        const n = hitScore(c.text, '');
        if (!n) continue;
        const age = ((now - c.mtime) / 86400000);
        const score = decay(age, this.halfLifeDays) * 0.6 + 0.05 * n;
        hits.push({ text: c.text, source: 'dsh', score, file: c.file });
      }
    }

    const seen = new Set();
    return hits
      .sort((a, b) => b.score - a.score)
      .filter((h) => (seen.has(h.text) ? false : (seen.add(h.text), true)))
      .slice(0, limit);
  }

  health() {
    const rows = this.rows();
    return { self: rows.length, core: rows.filter((r) => r.core).length, dsh: this.providers.includes('dsh') ? this.dshChunks().length : 0, file: this.file };
  }
}
