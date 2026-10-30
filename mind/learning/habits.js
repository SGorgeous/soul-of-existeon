/**
 * 习惯表（P2）
 *
 * 灵魂侧、世界无关：只记"在什么状态下，做某件事平均有多值得"。
 * 用于给漫游的"想做什么"加一点偏置——模型仍然是主导，习惯只调权重。
 *
 * 状态键 = 时段 | 心情档 | 驱动档 | 上一个动作
 * 落盘：state/souls/<id>/habits.jsonl
 */
import path from 'node:path';
import { readJsonl, writeJsonl } from '../store.js';

export const HABIT_ACTIONS = ['diary', 'note', 'search', 'think', 'soak', 'sun', 'eat', 'nap'];

const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const bucket = (n, step) => Math.round(Number(n) / step) * step;

export function contextKey({ part = '', mood = '', drive = 0, last = '' } = {}) {
  return [part, mood, bucket(drive, 0.25).toFixed(2), last].join('|');
}

export class HabitStore {
  constructor({ root, config = {} } = {}) {
    this.root = root;
    this.cfg = { alpha: 0.15, prior: 0.3, keep: 4000, ...config };
    this.cache = new Map();
  }

  fileOf(soulId) { return path.join(this.root, 'state', 'souls', String(soulId), 'habits.jsonl'); }

  rows(soulId) {
    if (this.cache.has(soulId)) return this.cache.get(soulId);
    const rows = readJsonl(this.fileOf(soulId), this.cfg.keep);
    this.cache.set(soulId, rows);
    return rows;
  }

  /** 某个状态下的"这件事平均多值得"（学习值；没有就用先验） */
  mean(soulId, ctx, action) {
    const row = this.rows(soulId).find((r) => r.ctx === ctx && r.action === action);
    return row ? Number(row.mean) : Number(this.cfg.prior);
  }

  count(soulId, ctx, action) {
    const row = this.rows(soulId).find((r) => r.ctx === ctx && r.action === action);
    return row ? Number(row.n) : 0;
  }

  /** 观测一次：滑动平均更新（rpe 式：新经验往旧预期上靠） */
  update(soulId, ctx, action, reward) {
    if (!soulId || !action) return null;
    const rows = this.rows(soulId);
    let row = rows.find((r) => r.ctx === ctx && r.action === action);
    if (!row) { row = { ctx, action, n: 0, mean: Number(this.cfg.prior), last: 0 }; rows.push(row); }
    row.n += 1;
    row.mean = Number((row.mean + Number(this.cfg.alpha) * (Number(reward) - row.mean)).toFixed(4));
    row.last = reward;
    writeJsonl(this.fileOf(soulId), rows, { keep: this.cfg.keep });
    return row;
  }

  /** 给候选动作打分（先验 + 学到的均值），供软选择 */
  scores(soulId, ctx, actions = HABIT_ACTIONS) {
    return actions.map((action) => {
      const n = this.count(soulId, ctx, action);
      const mean = this.mean(soulId, ctx, action);
      // 样本少时更信先验（置信度低），样本多才完全信学到的
      const conf = n / (n + 3);
      return { action, mean, n, score: Number((Number(this.cfg.prior) * (1 - conf) + mean * conf).toFixed(4)) };
    });
  }

  /** 软选择：温度越高越随机；explore 是纯探索概率 */
  pick(soulId, ctx, actions = HABIT_ACTIONS, { temperature = 0.35, explore = 0.12, rnd = Math.random } = {}) {
    if (rnd() < explore) return actions[Math.floor(rnd() * actions.length)];
    const s = this.scores(soulId, ctx, actions);
    const max = Math.max(...s.map((x) => x.score));
    const exps = s.map((x) => Math.exp((x.score - max) / Math.max(0.05, temperature)));
    const sum = exps.reduce((a, b) => a + b, 0) || 1;
    let r = rnd() * sum;
    for (let i = 0; i < s.length; i += 1) { r -= exps[i]; if (r <= 0) return s[i].action; }
    return s[s.length - 1].action;
  }

  /** 提示词里的一句话（可选；她可以知道自己的习惯） */
  line(soulId, ctx, actions = HABIT_ACTIONS) {
    const s = this.scores(soulId, ctx, actions).filter((x) => x.n >= 2).sort((a, b) => b.score - a.score);
    if (!s.length) return '';
    const top = s[0];
    const bottom = s[s.length - 1];
    return `你最近在类似的时候更常去「${top.action}」（${top.n} 次），不太常「${bottom.action}」。`;
  }

  /** 审计用 */
  snapshot(soulId) {
    return this.rows(soulId).slice(-50);
  }
}
