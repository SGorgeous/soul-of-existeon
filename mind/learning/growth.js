/**
 * 成长（P3）：后天人格的蜕变
 *
 * 只改灵魂自己的数据，不依赖世界、不进 UI：
 *   - 技能：search / note / diary / conversation / observation
 *     XP 按**学习内容**给（内容长度、新知识点、结果数），不是按次数堆
 *   - 特质：curiosity / order / sociability / persistence 缓慢漂移（每周 ±0.02 上限）
 *   - 成长日志：state/souls/<id>/growth.jsonl（里程碑、升级、特质变化）
 *
 * 提示词里只给一句"你最近更熟练/更爱做…"，她自己知道。
 */
import path from 'node:path';
import { readJson, writeJson, readJsonl, appendJsonl } from '../store.js';

const SKILLS = ['search', 'note', 'diary', 'conversation', 'observation'];
const TRAITS = ['curiosity', 'order', 'sociability', 'persistence'];

const WEEK = 7 * 86400_000;

function weekKey(now = Date.now()) { return String(Math.floor(now / WEEK)); }

export class Growth {
  constructor({ root, config = {}, logger = console } = {}) {
    this.root = root;
    this.cfg = {
      enabled: true,
      driftPerWeek: 0.02,
      levelCap: 9,
      ...config,
    };
    this.logger = logger;
  }

  fileOf(soulId) { return path.join(this.root, 'state', 'souls', String(soulId), 'growth.json'); }
  logFileOf(soulId) { return path.join(this.root, 'state', 'souls', String(soulId), 'growth.jsonl'); }

  load(soulId) {
    return readJson(this.fileOf(soulId)) || {
      skills: Object.fromEntries(SKILLS.map((k) => [k, { xp: 0, level: 0 }])),
      traits: Object.fromEntries(TRAITS.map((k) => [k, 0.5])),
      week: weekKey(),
      drift: Object.fromEntries(TRAITS.map((k) => [k, 0])),
      milestones: [],
    };
  }

  save(soulId, st) {
    writeJson(this.fileOf(soulId), st);
  }

  /** 她对什么感兴趣（自查的主题；用于"想学什么就学什么"和新颖度） */
  noteInterest(soulId, topic) {
    const t = String(topic || '').trim().slice(0, 40);
    if (!t) return null;
    const file = path.join(this.root, 'state', 'souls', String(soulId), 'interests.jsonl');
    const rows = readJsonl(file);
    const hit = rows.find((r) => r.topic === t);
    if (hit) { hit.n += 1; hit.lastAt = Date.now(); }
    else rows.push({ topic: t, n: 1, firstAt: Date.now(), lastAt: Date.now() });
    writeJsonl(file, rows, { keep: 200 });
    return rows;
  }

  event(soulId, ev) {
    appendJsonl(this.logFileOf(soulId), { t: Date.now(), ...ev });
  }

  levelOf(xp) { return Math.min(this.cfg.levelCap, Math.floor(Math.sqrt(Math.max(0, xp) / 4))); }

  /** 内容 → XP（学习内容驱动；重复/空洞内容给得少） */
  xpFrom({ kind, text = '', count = 0, novelty = 0.5 }) {
    const chars = String(text || '').trim().length;
    if (kind === 'search') return Math.min(12, chars / 12 + Number(count) * 0.6 + novelty * 2);
    if (kind === 'note') return Math.min(15, chars / 40 + novelty * 3);
    if (kind === 'diary') return Math.min(12, chars / 60 + novelty * 2);
    if (kind === 'conversation') return Math.min(10, chars / 80);
    if (kind === 'observation') return Math.min(6, Number(count) * 0.3);
    return 0;
  }

  /** 一轮/一次漫游后：加技能 XP，可能升级；特质只做极慢漂移 */
  learn(soulId, { kind, text = '', count = 0, novelty = 0.5, now = Date.now() } = {}) {
    if (!this.cfg.enabled || !soulId || !SKILLS.includes(kind)) return null;
    const st = this.load(soulId);
    if (st.week !== weekKey(now)) {
      st.week = weekKey(now);
      for (const k of TRAITS) st.drift[k] = 0;
    }
    const xp = this.xpFrom({ kind, text, count, novelty });
    if (xp <= 0) return null;
    const before = st.skills[kind]?.level || 0;
    st.skills[kind] = { xp: Math.round(((st.skills[kind]?.xp || 0) + xp) * 100) / 100, level: this.levelOf((st.skills[kind]?.xp || 0) + xp) };
    const after = st.skills[kind].level;
    if (after > before) this.event(soulId, { kind: 'level', skill: kind, level: after, xp: st.skills[kind].xp });

    // 特质漂移：学习内容性质决定方向，但每周总量有上限
    const drift = {
      search: ['curiosity', 0.0004],
      note: ['order', 0.0004],
      diary: ['persistence', 0.0003],
      conversation: ['sociability', 0.0004],
      observation: ['curiosity', 0.0002],
    }[kind];
    if (drift) {
      const [trait, base] = drift;
      const allow = Math.max(0, this.cfg.driftPerWeek - Math.abs(st.drift[trait]));
      const delta = Math.min(base, allow);
      if (delta > 0) {
        st.traits[trait] = Math.round(Math.min(1, st.traits[trait] + delta) * 10000) / 10000;
        st.drift[trait] = Number((Number(st.drift[trait] || 0) + delta).toFixed(6));
        if (!st._driftLogged || st._driftLogged !== `${st.week}|${trait}`) {
          this.event(soulId, { kind: 'trait', trait, value: st.traits[trait], week: st.week });
          st._driftLogged = `${st.week}|${trait}`;
        }
      }
    }
    this.save(soulId, st);
    return { kind, xp, level: after, skills: st.skills, traits: st.traits };
  }

  /** 每轮结束：从工具/回复里学 */
  observeTurn(turn, { persona = '', disposition = null } = {}) {
    if (!turn?.soul) return;
    try {
      const tools = turn.toolCalls || [];
      for (const c of tools) {
        if (c.name === 'web_search') {
          const list = c.result?.data;
          const n = Array.isArray(list) ? list.length : (list?.results?.length || 0);
          this.learn(turn.soul, { kind: 'search', text: String(c.args?.query || ''), count: n, novelty: 0.6 });
          this.noteInterest(turn.soul, String(c.args?.query || '').slice(0, 40));
        } else if (/note|record/.test(c.name)) {
          this.learn(turn.soul, { kind: 'note', text: String(c.args?.text || ''), novelty: 0.5 });
        } else if (/diary/.test(c.name)) {
          this.learn(turn.soul, { kind: 'diary', text: String(c.args?.text || ''), novelty: 0.5 });
        } else if (/look|listen|memory_recall/.test(c.name)) {
          this.learn(turn.soul, { kind: 'observation', count: 1 });
        }
      }
      const replyLen = (turn.replies || []).join('').length;
      if (replyLen) this.learn(turn.soul, { kind: 'conversation', text: (turn.replies || []).join(''), novelty: 0.4 });
    } catch { /* 不影响回复 */ }
  }

  /** 漫游：查资料/写日记/记笔记也算学习 */
  observeRoam(soulId, intent = {}, result = {}) {
    try {
      if (intent.action === 'search') { this.learn(soulId, { kind: 'search', text: String(intent.query || ''), count: 2, novelty: 0.7 }); this.noteInterest(soulId, String(intent.query || '').slice(0, 40)); }
      else if (intent.action === 'note') this.learn(soulId, { kind: 'note', text: String(intent.text || ''), novelty: 0.5 });
      else if (intent.action === 'diary') this.learn(soulId, { kind: 'diary', text: String(intent.text || ''), novelty: 0.5 });
    } catch { /* 忽略 */ }
  }

  /** 提示词里的一句话（只有她自己看到） */
  line(soulId) {
    try {
      if (!this.cfg.enabled) return '';
      const st = this.load(soulId);
      const top = SKILLS.map((k) => ({ k, level: st.skills[k]?.level || 0 })).sort((a, b) => b.level - a.level)[0];
      const bits = [];
      if (top && top.level >= 2) bits.push(`你在「${top.k}」上越来越熟了（${top.level} 级）。`);
      const t = st.traits || {};
      if ((t.curiosity || 0) > 0.6) bits.push('你最近比以前更好奇。');
      if ((t.order || 0) > 0.6) bits.push('你最近比以前更想整理东西。');
      return bits.join(' ');
    } catch { return ''; }
  }

  snapshot(soulId) { return this.load(soulId); }
}
