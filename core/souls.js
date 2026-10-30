import fs from 'node:fs';
import path from 'node:path';
import { readJson } from './read.js';

/**
 * Souls：人格 = 一个记忆命名空间。
 * 目录：state/souls/<id>/{soul.json, persona.md, memory.jsonl, people/, facts/, diary/, dreams/, records/}
 */
export class Souls {
  constructor({ root = process.cwd() } = {}) {
    this.root = root;
    this.dir = path.join(root, 'state', 'souls');
    this.defaultId = 'vaporeon';
  }

  baseDir(id) { return path.join(this.dir, String(id || this.defaultId)); }

  ensure(id = this.defaultId) {
    const dir = this.baseDir(id);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'soul.json');
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, JSON.stringify({ id, name: id === 'vaporeon' ? '水伊布' : id, createdAt: new Date().toISOString() }, null, 2));
    }
    return dir;
  }

  list() {
    try {
      return fs.readdirSync(this.dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))   // .trash 之类不露出来
        .map((d) => {
          const meta = this.read(d.name) || { id: d.name };
          return { ...meta, sessions: this.sessionCount(d.name) };
        });
    } catch { return []; }
  }

  read(id) {
    try { return readJson(path.join(this.baseDir(id), 'soul.json')); } catch { return null; }
  }

  exists(id) { return !!this.read(id); }

  /** 空 → 默认 soul；写了但不认识 → null（调用方决定报错还是回退） */
  resolve(id) {
    const key = String(id || '').trim();
    if (!key) return this.defaultId;
    return this.exists(key) ? key : null;
  }

  /** 改显示名（id 不变，目录不搬） */
  rename(id, name) {
    const meta = this.read(id);
    if (!meta) return { ok: false, error: '没有这个 soul：' + id };
    const n = String(name || '').trim().slice(0, 40);
    if (!n) return { ok: false, error: 'name 不能为空' };
    meta.name = n;
    fs.writeFileSync(path.join(this.baseDir(id), 'soul.json'), JSON.stringify(meta, null, 2));
    return { ok: true, soul: meta };
  }

/** 改「性格」标签（数组，几个短词），存在 soul.json 里，界面顶栏显示 */
  writeTraits(id, traits) {
    const meta = this.read(id);
    if (!meta) return { ok: false, error: '没有这个 soul：' + id };
    const list = (Array.isArray(traits) ? traits : String(traits ?? '').split(/[,，、\s]+/))
      .map((s) => String(s || '').trim()).filter(Boolean).slice(0, 6);
    meta.traits = list;
    try {
      fs.writeFileSync(path.join(this.baseDir(id), 'soul.json'), JSON.stringify(meta, null, 2));
      return { ok: true, traits: list };
    } catch (e) { return { ok: false, error: '写不下：' + String(e?.message || e) }; }
  }

  /** 改角色卡（markdown，直接覆盖 persona.md；太长会拖垮上下文预算，所以给个上限） */
  writePersona(id, text) {
    if (!this.read(id)) return { ok: false, error: '没有这个 soul：' + id };
    const s = String(text ?? '');
    if (!s.trim()) return { ok: false, error: 'persona 不能为空' };
    if (s.length > 20000) return { ok: false, error: '角色卡太长（> 20000 字）' };
    try {
      fs.writeFileSync(path.join(this.baseDir(id), 'persona.md'), s);
      return { ok: true, chars: s.length };
    } catch (e) {
      return { ok: false, error: '写不下：' + String(e?.message || e) };
    }
  }

  create({ id, name, persona = '' } = {}) {
    const key = String(id || '').trim();
    if (!/^[a-z0-9_-]{1,32}$/i.test(key)) return { ok: false, error: 'id 只能是字母数字下划线短横' };
    if (this.read(key)) return { ok: false, error: '已存在：' + key };
    const dir = this.ensure(key);
    fs.writeFileSync(path.join(dir, 'soul.json'), JSON.stringify({ id: key, name: name || key, createdAt: new Date().toISOString() }, null, 2));
    if (persona) fs.writeFileSync(path.join(dir, 'persona.md'), persona);
    return { ok: true, soul: this.read(key) };
  }

  sessionsDir(id) { return path.join(this.baseDir(id), 'sessions'); }

  sessionCount(id) {
    try {
      return fs.readdirSync(this.sessionsDir(id), { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.')).length;
    } catch { return 0; }
  }

  trashDir() { return path.join(this.dir, '.trash'); }

  /**
   * 删人格 = 整个目录移到 state/souls/.trash/<id>-<时间>，不是真删。
   * 默认人格不许删（删了内核没有落脚处）。
   */
  remove(id) {
    const meta = this.read(id);
    if (!meta) return { ok: false, error: '没有这个 soul：' + id };
    if (id === this.defaultId) return { ok: false, error: '默认人格不能删（可先换个默认，或改名当归档）' };
    try {
      fs.mkdirSync(this.trashDir(), { recursive: true });
      const dest = path.join(this.trashDir(), `${id}-${Date.now().toString(36)}`);
      fs.renameSync(this.baseDir(id), dest);
      return { ok: true, id, movedTo: path.relative(this.root, dest).split(path.sep).join('/') };
    } catch (e) {
      return { ok: false, error: '删不掉：' + String(e?.message || e) };
    }
  }

  /** 导出一个「人格包」：身份 + 角色卡 + 统计（不含人档案/记忆原文件） */
  exportBundle(id, stats = null) {
    const meta = this.read(id);
    if (!meta) return null;
    let persona = '';
    try { persona = fs.readFileSync(path.join(this.baseDir(id), 'persona.md'), 'utf8'); } catch { persona = ''; }
    return {
      kind: 'existeon.soul',
      version: 1,
      exportedAt: new Date().toISOString(),
      soul: meta,
      persona,
      stats: stats || null,
    };
  }
}
