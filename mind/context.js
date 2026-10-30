import fs from 'node:fs';
import path from 'node:path';
import { People } from './memory/people.js';
import { Memory } from './memory/index.js';
import { Facts } from './memory/facts.js';
import { readUtf8 } from '../core/read.js';

/** 粗略 token 估算：CJK 1 字 ≈ 1 token，其它 ≈ 4 字符 / token。 */
export function estimateTokens(text) {
  const s = String(text || '');
  let cjk = 0;
  for (const ch of s) if (/[\u3400-\u9fff\uf900-\ufaff]/.test(ch)) cjk += 1;
  return Math.ceil(cjk + (s.length - cjk) / 4);
}

/**
 * 上下文组装：角色卡 + 人档案 + 长期记忆 + 事实 + 教训 + 近期历史 + 本轮输入。
 * 预算按 token 估；超了先裁历史，再裁记忆，再裁事实，最后裁教训（角色卡永不裁）。
 */
export class ContextBuilder {
  constructor({ root, soulDir = null, personaFile = null, world = null, growth = null, budgetTokens = 3000, personaMaxChars = 6000, historyLimit = 20, memoryLimit = 5, factLimit = 4, lessonLimit = 3, disposition = null, stickers = null, memory: memoryCfg = {} } = {}) {
    this.root = root || process.cwd();
    this.soulDir = soulDir;
    this.world = world;
    this.growth = growth;
    this.personaFile = personaFile || (soulDir ? null : path.join(this.root, 'mind', 'persona.md'));
    this.budgetTokens = budgetTokens;
    this.personaMaxChars = personaMaxChars;
    this.disposition = disposition;
    this.stickers = stickers;
    this.historyLimit = historyLimit;
    this.memoryLimit = memoryLimit;
    this.factLimit = factLimit;
    this.lessonLimit = lessonLimit;
    if (soulDir) {
      this.people = new People({ root: this.root, dir: path.join(soulDir, 'people') });
      this.memoryStore = new Memory({ root: this.root, ...memoryCfg, providers: ['self'], file: path.join(soulDir, 'memory.jsonl') });
      this.factsStore = new Facts({ root: this.root, file: path.join(soulDir, 'facts', 'facts.jsonl') });
    } else {
      this.people = new People({ root: this.root });
      this.memoryStore = new Memory({ root: this.root, ...memoryCfg });
      this.factsStore = new Facts({ root: this.root });
    }
  }

  /** 现在的「处境」：用空间状态算，和页面显示的是同一份数据 */
  /** 绑定世界端口（装配层调用；没绑定就没有感官，不再自己造世界） */
  setWorld(world) {
    this.world = world;
    return this;
  }

  senses() {
    try {
      const soul = this.soulDir ? path.basename(this.soulDir) : null;
      if (this.world?.promptLine) return this.world.promptLine(soul);
      return '';
    } catch { return ''; }
  }

  persona() {
    const file = this.personaFile || (this.soulDir ? path.join(this.soulDir, 'persona.md') : path.join(this.root, 'mind', 'persona.md'));
    try {
      // 角色卡是「她是谁」，裁之前先给宽松上限（默认 6000 字，够放完整角色卡）
      return readUtf8(file).slice(0, this.personaMaxChars);
    } catch {
      return '你是水伊布，说话短。';
    }
  }

  personOf(channel, meta) {
    this.people.loadMeta();
    return this.people.personOf(channel, meta);
  }

  /** 人档案：state/people/<person>.jsonl。 */
  personHistory(person) {
    return this.people.historyLines(person, this.historyLimit);
  }

  /** 兜底历史：turns.jsonl 里同通道的回复。 */
  channelHistory(channel) {
    try {
      const rows = readUtf8(path.join(this.root, 'state', 'turns.jsonl'))
        .trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const me = this.soulDir ? path.basename(this.soulDir) : null;
      return rows.filter((t) => t.channel === channel && (!me || t.soul === me)).slice(-this.historyLimit)
        .map((t) => `【${t.channelLabel || t.channel}】我：${(t.replies || []).join(' / ')}`);
    } catch { return []; }
  }

  memory(text) {
    const hits = this.memoryStore.recall(text, { limit: this.memoryLimit });
    const lines = hits.map((h) => `- ${h.text}`);
    // 核心记忆不靠线索也在：永远排在最前面（去重）
    const core = this.memoryStore.coreRows ? this.memoryStore.coreRows(4) : [];
    const seen = new Set(lines);
    const coreLines = core.map((r) => `- ${r.text}`).filter((l) => (seen.has(l) ? false : (seen.add(l), true)));
    return { lines: [...coreLines, ...lines], hits: hits.length + coreLines.length };
  }

  facts(text) {
    const hits = this.factsStore.search(text, { limit: this.factLimit });
    return hits.map((f) => `- ${f.title}：${String(f.content || "").slice(0, 120)}`);
  }

  lessons(channel) {
    try {
      const rows = readUtf8(path.join(this.root, 'state', 'reflections.jsonl'))
        .trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const me = this.soulDir ? path.basename(this.soulDir) : null;
      return rows.filter((r) => r.channel === channel && (!r.soul || !me || r.soul === me)).slice(-this.lessonLimit).map((r) => `- ${r.text}`);
    } catch { return []; }
  }

  async build(turn) {
    const text = String(turn.input.text || '');
    const persona = this.persona();
    const mood = this.disposition ? this.disposition.promptBlock() : '';
    const stickerHint = this.stickers ? this.stickers.promptLine(turn.soul) : '';
    // 漫游时攒下的「想说的话」：她一个人待着的时候想到的，见面时自然带一句
    const pendingThought = turn.pendingThought ? String(turn.pendingThought).slice(0, 120) : '';
    // 感官：她现在到底在哪、旁边有谁、在干什么（空间状态是唯一权威）
    const senses = this.senses();
    const person = this.personOf(turn.channel, turn.meta);
    const mem = this.memory(text);
    const facts = this.facts(text);
    const lessons = this.lessons(turn.channel);
    let history = this.personHistory(person);
    if (!history.length) history = this.channelHistory(turn.channel);
    const inputLine = `[${turn.channelLabel}] ${text}${(turn.input.media || []).length ? `（附 ${turn.input.media.length} 个附件）` : ''}`;

    const budget = this.budgetTokens;
    const dropped = { history: 0, memory: 0, facts: 0, lessons: 0 };
    const used = () => estimateTokens([persona, mood, stickerHint, ...facts, ...mem.lines, ...lessons, ...history, inputLine].join('\n'));

    while (used() > budget && history.length > 1) {
      history.shift();
      dropped.history += 1;
    }
    while (used() > budget && mem.lines.length > 0) {
      mem.lines.shift();
      dropped.memory += 1;
    }
    while (used() > budget && facts.length > 0) {
      facts.shift();
      dropped.facts += 1;
    }
    while (used() > budget && lessons.length > 0) {
      lessons.shift();
      dropped.lessons += 1;
    }

    return {
      persona,
      growth: this.growth?.line?.(this.soulDir ? path.basename(this.soulDir) : null) || '',
      mood,
      stickerHint,
      pendingThought,
      senses,
      person,
      memory: mem.lines,
      memoryHits: mem.hits,
      facts,
      lessons,
      occurrences: [...history, inputLine],
      used: used(),
      budget,
      dropped,
    };
  }
}
