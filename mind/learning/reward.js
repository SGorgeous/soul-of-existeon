/**
 * 奖励引擎（P1：只算分、只落日志，不改行为）
 *
 * 归属：灵魂内核的独立功能，不依赖世界（世界只提供事件，不参与打分）。
 * 设计见 docs/GROWTH.md
 *
 * 多巴胺不是"快乐值"，而是**奖励预测误差**：这一轮比预期好多少。
 * 这里只负责把"发生了什么"翻译成十路信号和总分；怎么用（P2 的习惯偏置）以后再说。
 */
import path from 'node:path';
import { readJsonl, appendJsonl } from '../store.js';
import { HabitStore, contextKey } from './habits.js';

/** 十路奖励信号（越丰富越像人） */
export const SOURCES = [
  'novelty',     // 新鲜：没见过的内容/话题
  'competence',  // 胜任：工具成功、说出话、任务完成
  'social',      // 联结：被主人夸/被点名/被回应
  'consistency', // 一致：符合她的喜好
  'curiosity',   // 好奇：主动查/看/问
  'order',       // 秩序：记笔记/写日记/整理
  'mastery',     // 熟练：同一技能反复成功
  'needed',      // 被需要：主人直接叫她
  'recovery',    // 恢复：睡/休息之后
  'aesthetics',  // 审美：读到/看到好看的东西（预留）
];

const BASE = {
  novelty: 0.18, competence: 0.18, social: 0.22, consistency: 0.12,
  curiosity: 0.10, order: 0.06, mastery: 0.05, needed: 0.09, recovery: 0.04, aesthetics: 0.02,
};

function partOfDay(now = Date.now()) {
  const h = new Date(now).getHours();
  if (h < 6) return '深夜';
  if (h < 12) return '上午';
  if (h < 14) return '中午';
  if (h < 18) return '下午';
  if (h < 22) return '晚上';
  return '深夜';
}
function moodBucket(mood = '') {
  if (/开心|高兴|愉快/.test(mood)) return '开心';
  if (/不安|焦虑|害怕|着急/.test(mood)) return '不安';
  if (/嫌弃|烦/.test(mood)) return '嫌弃';
  return '平静';
}

const PRAISE = /乖|做得好|真棒|厉害|聪明|谢谢|喜欢|可爱|辛苦了|不错/;
const REST = /睡|休息|趴着|打盹|眯/;

export class RewardEngine {
  constructor({ root, config = {}, logger = console } = {}) {
    this.root = root;
    this.logger = logger;
    this.habits = new HabitStore({ root, config: config.habits || {} });
    this.cfg = {
      enabled: true,
      maxPerDay: 300,
      keep: 2000,
      ...config,
    };
  }

  dirOf(soulId) { return path.join(this.root, 'state', 'souls', String(soulId)); }
  fileOf(soulId) { return path.join(this.dirOf(soulId), 'rewards.jsonl'); }
  interestsOf(soulId) {
    return readJsonl(path.join(this.dirOf(soulId), 'interests.jsonl'));
  }

  /** 人格 → 十路信号的权重（同一件事，不同灵魂的分不一样） */
  weightsFor({ disposition = null, persona = '' } = {}) {
    const w = { ...BASE };
    const likes = disposition?.data?.likes || disposition?.likes || [];
    const dislikes = disposition?.data?.dislikes || disposition?.dislikes || [];
    const text = likes.join(' ') + ' ' + dislikes.join(' ') + ' ' + String(persona || '');
    if (/泡水|下雨|水/.test(text)) w.consistency += 0.05;
    if (/被摸头|被夸|喜欢被/.test(text)) w.social += 0.06;
    if (/查|学|好奇|看书/.test(text)) w.curiosity += 0.05;
    if (/安静|秩序|整理/.test(text)) w.order += 0.05;
    if (/怕生|冷淡|不善言辞/.test(text)) w.needed -= 0.03;
    if (/被冷落|被忽视/.test(text)) w.social += 0.04;
    const sum = Object.values(w).reduce((a, b) => a + Math.max(0, b), 0) || 1;
    for (const k of Object.keys(w)) w[k] = Math.max(0, w[k]) / sum;
    return w;
  }

  /** 算分：给"这一轮发生的事"，返回 { r, parts } */
  score(args = {}) {
    const { soulId = null, text = '', replies = [], tools = [], atMe = false, disposition = null, persona = '', now = Date.now(), action = '', ctx = '' } = args;
    const parts = Object.fromEntries(SOURCES.map((s) => [s, 0]));
    const said = String(text || '');
    const replied = (replies || []).filter((x) => String(x || '').trim()).length;
    const toolNames = (tools || []).map((t) => (typeof t === 'string' ? t : t.name)).filter(Boolean);
    const okTools = (tools || []).filter((t) => typeof t !== 'string' && t.ok !== false).length;

    // 社交：主人夸/点名
    if (PRAISE.test(said)) parts.social += 0.7;
    if (atMe) { parts.needed += 0.8; parts.social += 0.25; }
    // 胜任：说出话 + 工具成功
    if (replied) parts.competence += 0.4;
    if (okTools) parts.competence += Math.min(0.5, okTools * 0.2);
    // 好奇：主动查/看
    if (toolNames.some((n) => /search|look|listen/.test(n))) parts.curiosity += 0.7;
    // 秩序：记笔记/写日记/存记忆
    if (toolNames.some((n) => /note|diary|memory|record/.test(n))) parts.order += 0.7;
    // 新鲜：查的内容与既有兴趣不重合
    if (toolNames.includes('web_search')) {
      const q = String((tools.find((t) => t.name === 'web_search')?.args?.query) || '');
      const known = this.interestsOf(soulId || '');
      const dup = known.some((it) => q && (String(it.topic || '').includes(q) || q.includes(String(it.topic || ''))));
      parts.novelty += dup ? 0.2 : 0.9;
    }
    // 一致：回复里提到喜欢的事情
    const likes = (disposition?.data?.likes || disposition?.likes || []);
    if (likes.some((l) => said.includes(l) || (replies || []).join(' ').includes(l))) parts.consistency += 0.6;
    // 恢复：她自己在说休息/睡
    if (REST.test(said) || (replies || []).some((r) => REST.test(String(r)))) parts.recovery += 0.5;

    // 熟练（P1 只做占位：同一技能今天成功次数由调用方以后补）
    const w = this.weightsFor({ disposition, persona });
    let r = 0;
    for (const s of SOURCES) r += w[s] * Math.min(1, parts[s]);
    // 奖励预测误差的"预期"先固定 0.3（P2 接习惯表后替换）
    // 预期：从习惯表里学（同一状态、同一行为的历史均值）；没学过才用先验
    const expected = (args.action && args.ctx) ? this.habits.mean(args.soulId || soulId, args.ctx, args.action) : 0.3;
    const rpe = r - expected;
    return { r: Math.round(r * 1000) / 1000, rpe: Math.round(rpe * 1000) / 1000, expected: Math.round(expected * 1000) / 1000, parts, weights: w, at: now };
  }

  /** 落盘（只追加；上限内） */
  log(soulId, entry) {
    if (!this.cfg.enabled || !soulId) return null;
    const ok = appendJsonl(this.fileOf(soulId), entry, { keep: this.cfg.keep });
    return ok ? entry : null;
  }

  /** 一轮结束：记录这一轮的分（不改行为，只落盘） */
  observeTurn(turn, { disposition = null, persona = '' } = {}) {
    if (!turn?.soul) return null;
    const tools = (turn.toolCalls || []).map((c) => ({ name: c.name, ok: c.result?.ok !== false, args: c.args }));
    const atMe = !!(turn.meta?.atMe || turn.meta?.mentionsMe);
    const action = tools.length ? tools[tools.length - 1].name : 'say';
    const ctx = contextKey({ part: partOfDay(turn.at), mood: moodBucket(disposition?.state?.mood), drive: 0, last: '' });
    const s = this.score({ soulId: turn.soul, text: turn.input?.text, replies: turn.replies, tools, atMe, disposition, persona, action, ctx });
    try { this.habits.update(turn.soul, ctx, action, s.r); } catch { /* 忽略 */ }
    const daily = this.totals(turn.soul, s.at).count + 1;
    if (daily > this.cfg.maxPerDay) return null;
    return this.log(turn.soul, {
      t: s.at, turn: turn.id, channel: turn.channel,
      r: s.r, rpe: s.rpe, expected: s.expected, parts: s.parts, weights: s.weights,
    });
  }

  /** 漫游动作：只记（日记/查资料/笔记也算学习） */
  observeRoam(soulId, intent = {}, result = {}, { disposition = null, persona = '', drive = 0, mood = '', last = '' } = {}) {
    if (!soulId) return null;
    const actions = { search: ['curiosity', 0.8], note: ['order', 0.8], diary: ['order', 0.6], think: ['recovery', 0.3], speak: ['social', 0.4] };
    const [signal, amount] = actions[intent.action] || [null, 0];
    if (!signal) return null;
    const ctx = contextKey({ part: partOfDay(), mood: moodBucket(mood), drive, last });
    const s = this.score({ soulId, text: '', replies: ['x'], tools: intent.query ? [{ name: 'web_search', ok: true, args: { query: intent.query } }] : [], atMe: false, disposition, persona, action: intent.action, ctx });
    s.parts[signal] += amount;
    s.r = Math.round((s.r + amount * 0.2) * 1000) / 1000;
    try { this.habits.update(soulId, ctx, intent.action, s.r); } catch { /* 忽略 */ }
    return this.log(soulId, { t: Date.now(), kind: 'roam', action: intent.action, r: s.r, rpe: s.rpe, expected: s.expected, parts: s.parts, ctx });
  }

  /** 今天的累计（调试/审计用，不进 UI） */
  totals(soulId, now = Date.now()) {
    const day = new Date(now).toISOString().slice(0, 10);
    const rows = readJsonl(this.fileOf(soulId));
    if (!rows.length) return { day, count: 0, sum: 0, avg: 0 };
    const today = rows.filter((x) => new Date(x.t).toISOString().slice(0, 10) === day);
    const sum = today.reduce((a, b) => a + (Number(b.r) || 0), 0);
    return { day, count: today.length, sum: Math.round(sum * 1000) / 1000, avg: today.length ? Math.round(sum / today.length * 1000) / 1000 : 0 };
  }
}
