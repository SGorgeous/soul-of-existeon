import path from 'node:path';
import { tokensOf } from './index.js';
import { readText, writeText, appendText, writeTextAtomic, listFiles, ensureText } from '../store.js';

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const clock = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

/**
 * 笔记 / 日记 / 梦：都按「需要时翻」设计，不自动进上下文。
 * - 笔记 <base>/records/notes.md（长在，按需查）
 * - 日记 <base>/diary/YYYY-MM-DD.md
 * - 梦   <base>/dreams/YYYY-MM-DD.md
 * base 默认 root/state；多灵魂时传 soul 目录（state/souls/<id>）。
 */
export class Records {
  constructor({ root, dir } = {}) {
    this.root = root || process.cwd();
    const base = dir || path.join(this.root, 'state');
    this.base = base;
    this.notesFile = path.join(base, 'records', 'notes.md');
    this.diaryDir = path.join(base, 'diary');
    this.dreamDir = path.join(base, 'dreams');
  }

  append(file, text) {
    const ok = appendText(file, text);
    return ok ? { ok: true, file } : { ok: false, error: '写不进去：' + file };
  }

  noteAdd(text, { tags = [], title = '' } = {}) {
    const t = String(text || '').trim();
    if (!t) return { ok: false, error: 'text 不能为空' };
    const tag = (Array.isArray(tags) ? tags : []).join(' ');
    const head = title
      ? `${title} · ${dayKey()} ${clock()}`
      : `${dayKey()} ${clock()}`;
    const header = `## ${head}${tag ? ' [' + tag + ']' : ''}\n`;
    ensureText(this.notesFile, '# 笔记\n');
    return this.append(this.notesFile, `\n${header}${t}\n`);
  }

/** 笔记解析：`## 标题 · 2026/10/26 23:55:44 [标签 标签]` + 正文 */
  static parseNoteHead(head) {
    let h = String(head || '').trim();
    let tags = [];
    const mTag = h.match(/\[([^\]]+)\]\s*$/);
    if (mTag) { tags = mTag[1].split(/[,，、\s]+/).filter(Boolean); h = h.slice(0, mTag.index).trim(); }
    let title = h;
    let ts = null;
    const m = h.match(/^(.*?)\s*·\s*(\d{4}[/-]\d{1,2}[/-]\d{1,2})(?:\s+(\d{1,2}:\d{2}(?::\d{2})?))?\s*$/);
    if (m) {
      title = m[1].trim();
      ts = Date.parse(`${m[2].replace(/\//g, '-')} ${m[3] || '00:00:00'}`);
    } else {
      const only = h.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})$/);
      if (only) { title = ''; ts = Date.parse(`${only[1]} ${only[2]}`); }
    }
    return { title: title || '（无标题）', ts: Number.isFinite(ts) ? ts : null, tags };
  }

  /** 笔记卡片：一条一卡，带 index 当 id（整表重写，所以 index 就够了） */
  noteCards() {
    return this.noteBlocks().map((b, i) => {
      const h = Records.parseNoteHead(b.title);
      return { id: 'n-' + i, title: h.title, ts: h.ts, tags: h.tags, content: b.content };
    });
  }

  /** 整表写回笔记（卡片保存用） */
  writeNotes(rows = []) {
    const blocks = [];
    for (const r of rows) {
      const content = String(r.content || '').trim();
      const title = String(r.title || '').trim() || '（无标题）';
      const tags = Array.isArray(r.tags) ? r.tags.map(String).filter(Boolean) : String(r.tags || '').split(/[,，、\s]+/).filter(Boolean);
      if (!content && !title) continue;
      const d = new Date(Number(r.ts) || Date.now());
      const stamp = `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      const head = `## ${title} · ${stamp}${tags.length ? ' [' + tags.join(' ') + ']' : ''}`;
      blocks.push(`${head}\n\n${content}`);
    }
    const ok = writeTextAtomic(this.notesFile, '# 笔记\n\n' + blocks.join('\n\n') + '\n');
    if (!ok) return { ok: false, error: '写不进去：' + this.notesFile };
    return { ok: true, count: blocks.length };
  }

  noteBlocks() {
    const raw = readText(this.notesFile);
    return raw.split(/^## /m).slice(1).map((b) => {
      const nl = b.indexOf('\n');
      const head = nl >= 0 ? b.slice(0, nl) : b;
      const body = nl >= 0 ? b.slice(nl + 1) : '';
      return { title: head.trim(), content: body.trim() };
    });
  }

  noteSearch(query, { limit = 5 } = {}) {
    const tokens = tokensOf(query);
    if (!tokens.length) return [];
    return this.noteBlocks()
      .filter((b) => tokens.some((t) => (b.title + b.content).includes(t)))
      .slice(-limit)
      .reverse()
      .map((b) => ({ title: b.title, content: b.content.slice(0, 500) }));
  }

  /**
   * 写日记。格式沿用老插件：
   *   ## 18:39:54 · 标题
   *
   *   正文（她自己的话，第一人称，可以分几段）
   *
   * 若传入文本本身已带 `## ` 或 `- ` 头，则原样追加（兼容旧记录/手工编辑）。
   */
  diaryWrite(text, { date = dayKey(), title = '', source = '' } = {}) {
    const t = String(text || '').trim();
    if (!t) return { ok: false, error: 'text 不能为空' };
    const file = path.join(this.diaryDir, date + '.md');
    ensureText(file, `# ${date}\n`);
    if (/^(##\s|-\s)/.test(t)) return this.append(file, t.endsWith('\n') ? t : t + '\n');
    const head = [clock(), title || source || '随手记'].filter(Boolean).join(' · ');
    return this.append(file, `\n## ${head}\n\n${t}\n`);
  }

  diaryRead({ date = '', limit = 3 } = {}) {
    const files = listFiles(this.diaryDir, '.md').sort();
    if (!files.length) return [];
    const pick = date ? files.filter((f) => f.startsWith(date)) : files.slice(-limit);
    return pick.map((f) => ({
      date: f.replace(/\.md$/, ''),
      content: readText(path.join(this.diaryDir, f)).trim().slice(0, 4000),
    }));
  }

  dreamWrite(text, { date = dayKey() } = {}) {
    const t = String(text || '').trim();
    if (!t) return { ok: false, error: 'text 不能为空' };
    const file = path.join(this.dreamDir, date + '.md');
    ensureText(file, `# ${date}\n`);
    return this.append(file, `- ${clock()} ${t}\n`);
  }

  dreamRecall(query = '', { limit = 5 } = {}) {
    const tokens = tokensOf(query);
    const files = listFiles(this.dreamDir, '.md').sort().reverse();
    const out = [];
    for (const f of files) {
      const text = readText(path.join(this.dreamDir, f));
      for (const line of text.split('\n').filter((l) => l.startsWith('- '))) {
        const content = line.slice(2).trim();
        if (!content) continue;
        if (tokens.length && !tokens.some((t) => content.includes(t))) continue;
        out.push({ date: f.replace(/\.md$/, ''), content });
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  health() {
    const diary = listFiles(this.diaryDir, '.md').length;
    const dreams = listFiles(this.dreamDir, '.md').length;
    return { notes: this.noteBlocks().length, diary, dreams };
  }
}
