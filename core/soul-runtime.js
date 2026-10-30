import fs from 'node:fs';
import path from 'node:path';
import { ContextBuilder } from '../mind/context.js';
import { Records } from '../mind/memory/records.js';
import { Disposition } from '../mind/disposition.js';
import { Vitals } from '../physiology/index.js';
import { Stickers } from '../mind/stickers.js';

import { Souls } from './souls.js';

const defaultPersona = (name) => `你是${name}。说话短，不用解释自己是谁。\n`;

/** 从角色卡里抠「性格：黏人、怕生」这种行；没有就返回空数组 */
function parseTraits(text) {
  const m = /^[\s\-*·]*性格\s*[：:]\s*(.+)$/m.exec(String(text || ''));
  if (!m) return [];
  return m[1].split(/[、，,／/\s]+/).map((s) => s.trim()).filter(Boolean).slice(0, 6);
}

/**
 * 一个 soul 的运行时：它自己的目录 + 上下文 + 记忆/事实/人/记录。
 * 同一个 soul 的所有会话共用这一套（会话只切「聊到哪」，不切记忆）。
 */
export class SoulRuntime {
  constructor({ root, config = {}, id, souls, world = null, growth = null }) {
    this.root = root;
    this.config = config;
    this.id = id;
    this.souls = souls;
    this.dir = souls.ensure(id);
    this.meta = souls.read(id) || { id, name: id };
    this.name = this.meta.name || id;
    this.personaFile = path.join(this.dir, 'persona.md');
    if (!fs.existsSync(this.personaFile)) {
      // 默认 soul 沿用老的角色卡（迁移过来的数据都在这份里），新 soul 起一份中性模板
      let text = defaultPersona(this.name);
      if (id === souls.defaultId) {
        try { text = fs.readFileSync(path.join(root, 'mind', 'persona.md'), 'utf8'); } catch { /* 用模板 */ }
      }
      try { fs.writeFileSync(this.personaFile, text); } catch { /* 只读环境 */ }
    }
    // 倾向（心情/焦虑/喜恶）：每个灵魂自己一份，落在自己目录里
    let personaText = '';
    try { personaText = fs.readFileSync(this.personaFile, 'utf8'); } catch { /* 没卡就用默认喜恶 */ }
    this.disposition = new Disposition({
      soulDir: this.dir,
      persona: personaText,
      ...(config.disposition || {}),
    });
// 性格标签：soul.json 里手写的优先；没有就从角色卡里抠「性格：…」
    this.traits = Array.isArray(this.meta.traits) && this.meta.traits.length
      ? this.meta.traits.map(String).slice(0, 6)
      : parseTraits(personaText);

    // 生理（体力/精力/睡眠）：每个灵魂一份。
    // 第一次建档时继承一次（优先默认灵魂的当前体力，其次老的全局 state/vitals.json）
    this.vitalsFile = path.join(this.dir, 'vitals.json');
    if (!fs.existsSync(this.vitalsFile)) {
      const seeds = [
        id === souls.defaultId ? null : path.join(souls.baseDir(souls.defaultId), 'vitals.json'),
        path.join(root, 'state', 'vitals.json'),
      ].filter(Boolean);
      for (const src of seeds) {
        try {
          if (fs.existsSync(src)) { fs.copyFileSync(src, this.vitalsFile); break; }
        } catch { /* 试下一个 */ }
      }
    }
    this.vitals = new Vitals({ root, config: config.vitals || {}, stateFile: this.vitalsFile });
    this.stickers = new Stickers({ root, ...(config.stickers || {}) });

    this.context = new ContextBuilder({
      world,
      growth,
      root,
      soulDir: this.dir,
      personaFile: this.personaFile,
      disposition: this.disposition,
      stickers: this.stickers,
      ...(config.context || {}),
      memory: config.memory || {},
    });
    this.records = new Records({ root, dir: this.dir });
    // 上下文里的这三份就是本 soul 的存储，工具也写它们（同一个实例，文件同一份）
    this.memory = this.context.memoryStore;
    this.facts = this.context.factsStore;
    this.people = this.context.people;
  }

  persona() { return this.context.persona(); }

  stats() {
    let memory = null;
    try { memory = this.memory.health ? this.memory.health() : null; } catch { memory = null; }
    let people = 0;
    try { people = Object.keys(this.people.data?.accounts || {}).length; } catch { people = 0; }
    let facts = 0;
    try { facts = this.facts.rows().length; } catch { facts = 0; }
    return {
      id: this.id,
      name: this.name,
      dir: path.relative(this.root, this.dir).split(path.sep).join('/'),
      personaChars: this.persona().length,
      traits: this.traits || [],
      stickers: this.stickers ? this.stickers.list(this.id).length : 0,
      mood: this.disposition?.state.mood || null,
      anxiety: this.disposition?.state.anxiety ?? null,
      vitals: this.vitals
        ? {
          energy: Number(this.vitals.state.energy.toFixed(1)),
          focus: Number(this.vitals.state.focus.toFixed(1)),
          stage: this.vitals.state.stage,
          resting: !!this.vitals.state.resting,
        }
        : null,
      memory,
      facts,
      people,
      records: this.records.health(),
    };
  }
}

/**
 * 运行时缓存：按 soul id 懒建。ContextBuilder / Records / Memory 都持有文件路径，
 * 所以换 soul 不需要重建内核，只要换这一层。
 */
export class SoulRuntimes {
  constructor({ root, config = {} } = {}) {
    this.root = root || process.cwd();
    this.config = config;
    this.souls = new Souls({ root: this.root });
    this.defaultId = String(config.soul || this.souls.defaultId);
    // 全新安装也要有默认人格：否则第一次打开界面是空的、/api/souls/:id 直接 404
    try { this.souls.ensure(this.defaultId); } catch { /* 只读环境把错留给上层 */ }
    this.cache = new Map();
  }

  /** 空 → 默认 soul；不存在 → null（默认 soul 第一次用时自动建档） */
  resolve(id) {
    const key = String(id || '').trim();
    if (!key) return this.defaultId;
    if (this.souls.exists(key)) return key;
    if (key === this.defaultId) {
      this.souls.ensure(key);
      return key;
    }
    return null;
  }

  get(id) {
    const key = this.resolve(id);
    if (!key) return null;
    if (!this.cache.has(key)) {
      this.cache.set(key, new SoulRuntime({ root: this.root, config: this.config, world: this.world, growth: this.growth, id: key, souls: this.souls }));
    }
    return this.cache.get(key);
  }

  /** 新建/改名后丢掉缓存，下次按新文件重建 */
  invalidate(id) {
    if (id) this.cache.delete(String(id));
    else this.cache.clear();
  }

  health() {
    const rt = this.get(this.defaultId);
    return rt ? { defaultSoul: this.defaultId, ...rt.stats() } : { defaultSoul: this.defaultId, souls: 0 };
  }
}
