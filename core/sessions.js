import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { readJson, readUtf8 } from './read.js';

const SESSION_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/i;

/** 会话：属于某个 soul；同一 soul 的会话共用该 soul 的记忆。 */
export class Sessions {
  constructor({ root = process.cwd() } = {}) {
    this.root = root;
    this.dir = path.join(root, 'state', 'souls');
  }

  soulDir(soulId) { return path.join(this.dir, String(soulId || 'vaporeon')); }
  dirOf(soulId, sessionId) { return path.join(this.soulDir(soulId), 'sessions', String(sessionId)); }

  /** 列会话：默认不列归档的（`?archived=1` 才列）；回收站目录（.trash）永不列出 */
  list(soulId, { includeArchived = false } = {}) {
    try {
      return fs.readdirSync(path.join(this.soulDir(soulId), 'sessions'), { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .map((d) => {
          const meta = this.read(soulId, d.name) || { id: d.name };
          const turns = this.turns(soulId, d.name);
          return {
            ...meta,
            turns: turns.length,
            lastAt: turns.length ? turns[turns.length - 1].at || meta.updatedAt : meta.updatedAt || null,
            lastText: turns.length ? String(turns[turns.length - 1].input?.text || '').slice(0, 60) : '',
          };
        })
        .filter((s) => includeArchived || !s.archived)
        .sort((a, b) => String(b.lastAt || b.updatedAt || '').localeCompare(String(a.lastAt || a.updatedAt || '')));
    } catch { return []; }
  }

/** 分页版 list：会话多了不用一次全读 */
  page(soulId, { offset = 0, limit = 50, includeArchived = false } = {}) {
    const all = this.list(soulId, { includeArchived });
    const start = Math.max(0, Number(offset) || 0);
    const size = Math.max(1, Math.min(200, Number(limit) || 50));
    const sessions = all.slice(start, start + size);
    return {
      sessions,
      total: all.length,
      offset: start,
      limit: size,
      hasMore: start + sessions.length < all.length,
    };
  }

  read(soulId, sessionId) {
    try { return readJson(path.join(this.dirOf(soulId, sessionId), 'session.json')); } catch { return null; }
  }

  newId() {
    return 's-' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
  }

  create(soulId, { title, id } = {}) {
    const sid = id && SESSION_ID.test(String(id)) ? String(id) : this.newId();
    const dir = this.dirOf(soulId, sid);
    fs.mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    const meta = { id: sid, title: String(title || '').trim().slice(0, 40) || '新对话', soul: soulId, createdAt: now, updatedAt: now };
    fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify(meta, null, 2));
    return meta;
  }

  /**
   * 打开会话：给了 id 就取（没有就按这个 id 建），没给就用该 soul 的默认会话。
   * 这样老客户端（不带 sessionId）也不会每条消息新建一个会话。
   */
  open(soulId, sessionId) {
    const sid = String(sessionId || '').trim();
    if (!sid) return this.open(soulId, 's-default');
    if (!SESSION_ID.test(sid)) return null;
    const existing = this.read(soulId, sid);
    if (existing) return existing;
    return this.create(soulId, { id: sid });
  }

  turns(soulId, sessionId) {
    try {
      return readUtf8(path.join(this.dirOf(soulId, sessionId), 'turns.jsonl'))
        .trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  }

  appendTurn(soulId, sessionId, turn) {
    if (!soulId || !sessionId) return null;
    const dir = this.dirOf(soulId, sessionId);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'turns.jsonl'), JSON.stringify(turn) + '\n');
    try {
      const meta = this.read(soulId, sessionId) || { id: sessionId, title: '新对话', soul: soulId };
      // 第一轮的用户输入当标题（「新对话」时自动命名），之后不动
      if ((!meta.title || meta.title === '新对话') && String(turn?.input?.text || '').trim()) {
        meta.title = String(turn.input.text).trim().replace(/\s+/g, ' ').slice(0, 24);
      }
      meta.updatedAt = new Date().toISOString();
      meta.turns = this.turns(soulId, sessionId).length;
      fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify(meta, null, 2));
      return meta;
    } catch { return null; }
  }

  rename(soulId, sessionId, title) {
    const meta = this.read(soulId, sessionId);
    if (!meta) return { ok: false, error: '没有这个会话：' + sessionId };
    const t = String(title || '').trim().slice(0, 40);
    if (!t) return { ok: false, error: 'title 不能为空' };
    meta.title = t;
    meta.updatedAt = new Date().toISOString();
    fs.writeFileSync(path.join(this.dirOf(soulId, sessionId), 'session.json'), JSON.stringify(meta, null, 2));
    return { ok: true, session: meta };
  }

  /** 归档：从列表里收起来，记录还在（`archived: false` 可恢复） */
  archive(soulId, sessionId, archived = true) {
    const meta = this.read(soulId, sessionId);
    if (!meta) return { ok: false, error: '没有这个会话：' + sessionId };
    if (archived) meta.archived = true; else delete meta.archived;
    meta.updatedAt = new Date().toISOString();
    try {
      fs.writeFileSync(path.join(this.dirOf(soulId, sessionId), 'session.json'), JSON.stringify(meta, null, 2));
      return { ok: true, session: meta };
    } catch (e) {
      return { ok: false, error: '写不下：' + String(e?.message || e) };
    }
  }

  trashDir(soulId) { return path.join(this.soulDir(soulId), 'sessions', '.trash'); }

  /** 删会话 = 整个目录移到 sessions/.trash/<sid>-<时间>（回收站，可恢复） */
  remove(soulId, sessionId) {
    const meta = this.read(soulId, sessionId);
    if (!meta) return { ok: false, error: '没有这个会话：' + sessionId };
    try {
      fs.mkdirSync(this.trashDir(soulId), { recursive: true });
      const dest = path.join(this.trashDir(soulId), `${sessionId}-${Date.now().toString(36)}`);
      fs.renameSync(this.dirOf(soulId, sessionId), dest);
      return { ok: true, id: sessionId, movedTo: path.relative(this.root, dest).split(path.sep).join('/') };
    } catch (e) {
      return { ok: false, error: '删不掉：' + String(e?.message || e) };
    }
  }
}
