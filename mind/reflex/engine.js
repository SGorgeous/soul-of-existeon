import fs from 'node:fs';
import path from 'node:path';
import { readJson } from '../../core/read.js';
import { parseReflexText, ruleMatches } from './dsl.js';

function channelMatches(pattern, channel) {
  const p = String(pattern || '');
  const ch = String(channel || '');
  if (p === '*') return true;
  if (p.endsWith(':*')) return ch.startsWith(p.slice(0, -1));
  return p === ch;
}

/** 老格式（JSON）的匹配，保留兼容 */
function matchLegacy(rule, ctx) {
  if (Array.isArray(rule.channels) && rule.channels.length && !rule.channels.some((p) => channelMatches(p, ctx.channel))) return false;
  const text = String(ctx.text || '');
  if (rule.regex) {
    try { if (!new RegExp(rule.regex).test(text)) return false; } catch { return false; }
  }
  if (Array.isArray(rule.keywords) && rule.keywords.length) return rule.keywords.some((k) => text.includes(String(k)));
  return !!rule.regex;
}

/**
 * 条件反射（潜意识层）：输入进来先过一遍「当……就……」，命中就直接做，**不调模型、不进思考**。
 *
 * 规则来源（按优先级合并）：
 *   1. config.reflex.rules            —— 出厂 JSON（老格式，兼容）
 *   2. state/reflexes.json            —— 老格式的规则文件
 *   3. state/reflexes.txt             —— 新格式「当……就……」（推荐：人写起来直观）
 *   4. state/souls/<id>/reflexes.txt  —— 某个灵魂自己的条件反射
 *
 * 动作：回（可给多个说法随机挑）/ 不说 / 改写 / 发表情。
 */
export class Reflex {
  constructor({ root, config = {}, logger = console } = {}) {
    this.root = root || process.cwd();
    this.cfg = {
      enabled: true,
      cooldownMs: 0,
      file: null,
      dsl: 'state/reflexes.txt',
      soulDsl: 'reflexes.txt',
      rules: [],
      ...config,
    };
    this.file = this.cfg.file ? path.resolve(this.root, this.cfg.file) : path.join(this.root, 'state', 'reflexes.json');
    this.dslFile = path.resolve(this.root, this.cfg.dsl || 'state/reflexes.txt');
    this.logger = logger;
    this.rules = [];
    this.dslErrors = [];
    this.last = new Map();
    this.lastPick = new Map();
    this.lastMs = 0;
    this.soulCache = new Map();
    this.load();
  }

  load() {
    const rules = [];
    // 1) 出厂 JSON
    if (Array.isArray(this.cfg.rules)) {
      for (const r of this.cfg.rules) rules.push({ ...r, source: r.source || 'config', format: 'json' });
    }
    // 2) 老 JSON 文件
    try {
      const j = readJson(this.file);
      const fileRules = Array.isArray(j) ? j : j.rules;
      if (Array.isArray(fileRules)) for (const r of fileRules) rules.push({ ...r, source: r.source || 'json', format: 'json' });
    } catch { /* 没有规则文件 */ }
    // 3) 新 DSL 文件
    try {
      const txt = fs.readFileSync(this.dslFile, 'utf8');
      const parsed = parseReflexText(txt);
      this.dslErrors = parsed.errors;
for (const r of parsed.rules) rules.push({ ...r, format: 'dsl' });
      // 只要有 DSL 规则，就以它为准（老 JSON 规则不再参与，避免两边打架）
      if (parsed.rules.length) {
        const legacy = rules.filter((r) => r.format !== 'dsl');
        if (legacy.length) this.logger.info?.(`[reflex] 用 ${this.dslFile} 里的 ${parsed.rules.length} 条规则（忽略 ${legacy.length} 条 JSON 老规则）`);
        rules.length = 0;
        for (const r of parsed.rules) rules.push({ ...r, format: 'dsl' });
      }
      if (parsed.errors.length) this.logger.warn?.('[reflex] DSL 有 ' + parsed.errors.length + ' 行没读懂：' + parsed.errors.join('；'));
    } catch { /* 没有 DSL 文件 */ }

    this.rules = rules
      .map((r, i) => ({ ...r, _order: i }))
      .sort((a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0) || a._order - b._order);
    return this.rules;
  }

  /** 某个灵魂自己的 DSL（懒加载 + 缓存） */
  soulRules(soulDir) {
    if (!soulDir) return [];
    const file = path.join(soulDir, this.cfg.soulDsl || 'reflexes.txt');
    if (this.soulCache.has(file)) return this.soulCache.get(file);
    let rules = [];
    try {
      const parsed = parseReflexText(fs.readFileSync(file, 'utf8'));
      rules = parsed.rules.map((r) => ({ ...r, source: 'soul', format: 'dsl' }));
      if (parsed.errors.length) this.logger.warn?.('[reflex] ' + file + ' 有 ' + parsed.errors.length + ' 行没读懂');
    } catch { /* 没有就没有 */ }
    this.soulCache.set(file, rules);
    return rules;
  }

  bypassed(turn) {
    const by = turn?.bypass || [];
    return by.includes('all') || by.includes('reflex');
  }

  /** 多说法时避开上一次用过的那句 */
  pickVariant(name, variants) {
    const list = (variants || []).map((x) => String(x)).filter((x) => x.trim());
    if (!list.length) return '';
    if (list.length === 1) return list[0];
    const prev = this.lastPick.get(name);
    const pool = list.filter((x) => x !== prev);
    const pick = pool[Math.floor(Math.random() * pool.length)] || list[0];
    this.lastPick.set(name, pick);
    return pick;
  }

  /**
   * @param {object} turn
   * @param {object} ctx  { text, channel, person, mood, anxiety, silenceMin, energy, now }
   */
  check(turn, ctx = {}) {
    if (!this.cfg.enabled) return null;
    if (this.bypassed(turn)) return null;
    const started = process.hrtime.bigint();

    const c = {
      text: String(ctx.text ?? turn?.input?.text ?? ''),
      channel: String(ctx.channel ?? turn?.channel ?? ''),
      person: ctx.person ?? turn?.person ?? turn?.meta?.person ?? '',
      mood: ctx.mood ?? turn?.mood ?? '',
      anxiety: Number(ctx.anxiety ?? turn?.anxiety ?? 0),
      silenceMin: Number(ctx.silenceMin ?? turn?.silence?.sinceMinutes ?? 0),
      energy: Number(ctx.energy ?? turn?.vitals?.energy ?? 100),
      now: ctx.now || Date.now(),
    };
// 全局规则 + 这个灵魂自己的规则，按优先级合并（同优先级全局先）
    const rules = [...(this.rules || []), ...this.soulRules(turn?.soulDir || null)]
      .map((r, i) => ({ ...r, _i: i }))
      .sort((a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0) || a._i - b._i);

    for (const rule of rules) {
      const hit = rule.format === 'dsl' ? ruleMatches(rule, c) : matchLegacy(rule, c);
      if (!hit) continue;
      const key = rule.name || rule.regex || (rule.keywords || []).join('|');
      const cooldown = Number(rule.cooldownMs ?? this.cfg.cooldownMs) || 0;
      if (cooldown && c.now - (this.last.get(key) || 0) < cooldown) continue;
      this.last.set(key, c.now);

      // DSL：动作可以叠加（回 + 发表情）
      if (rule.format === 'dsl') {
        const actions = rule.actions || [];
        const replyAct = actions.find((a) => a.kind === 'reply');
        const stickerAct = actions.find((a) => a.kind === 'sticker');
        const silent = actions.some((a) => a.kind === 'silent');
        const rewrite = actions.find((a) => a.kind === 'rewrite');
        const out = {
          rule: key,
          source: rule.source,
          action: silent ? 'silent' : rewrite ? 'rewrite' : (replyAct ? 'reply' : 'sticker'),
          reply: replyAct ? this.pickVariant(key, replyAct.variants) : null,
          rewrite: rewrite ? rewrite.text : null,
          sticker: stickerAct ? stickerAct.emotion : null,
          regex: null,
        };
        out.ms = Number(process.hrtime.bigint() - started) / 1e6;
        this.lastMs = out.ms;
        return out;
      }

      // 老格式
      const out = {
        rule: key,
        source: rule.source,
        action: rule.action || 'reply',
        reply: rule.reply,
        rewrite: rule.rewrite,
        regex: rule.regex || null,
        sticker: rule.sticker || null,
      };
      out.ms = Number(process.hrtime.bigint() - started) / 1e6;
      this.lastMs = out.ms;
      return out;
    }
    this.lastMs = Number(process.hrtime.bigint() - started) / 1e6;
    return null;
  }

  health() {
    const dsl = this.rules.filter((r) => r.format === 'dsl');
    return {
      enabled: !!this.cfg.enabled,
      rules: this.rules.length,
      dsl: dsl.length,
      json: this.rules.length - dsl.length,
      names: this.rules.map((r) => r.name || r.regex || (r.keywords || []).join('/')).slice(0, 16),
      errors: this.dslErrors.slice(0, 5),
      lastMs: this.lastMs,
      file: this.file,
      dslFile: this.dslFile,
    };
  }
}
