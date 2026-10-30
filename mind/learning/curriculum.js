/**
 * 学习目标 + 间隔复习（P4）
 *
 * 兴趣来自 interests.jsonl；每次查资料会推进目标，并按间隔安排复习：
 *   1 天 → 3 天 → 7 天 → 14 天 → 30 天 → 60 天
 *
 * 数据：state/souls/<id>/learning.json
 * 只写灵魂自己的目录，不依赖世界。
 */
import fs from 'node:fs';
import path from 'node:path';

const INTERVALS = [1, 3, 7, 14, 30, 60];
const DAY = 86400_000;

export class Learning {
  constructor({ root, config = {} } = {}) {
    this.root = root;
    this.cfg = { maxGoals: 12, defaultIntervalDays: 1, ...config };
  }

  fileOf(soulId) { return path.join(this.root, 'state', 'souls', String(soulId), 'learning.json'); }

  stateOf(soulId) {
    try {
      const j = JSON.parse(fs.readFileSync(this.fileOf(soulId), 'utf8'));
      return { goals: Array.isArray(j.goals) ? j.goals : [] };
    } catch { return { goals: [] }; }
  }

  save(soulId, st) {
    try {
      fs.mkdirSync(path.dirname(this.fileOf(soulId)), { recursive: true });
      fs.writeFileSync(this.fileOf(soulId), JSON.stringify(st, null, 2));
    } catch { /* 写不进不阻塞 */ }
  }

  interests(soulId) {
    try {
      return fs.readFileSync(path.join(this.root, 'state', 'souls', String(soulId), 'interests.jsonl'), 'utf8')
        .trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  }

  /** 没有目标时，从兴趣里挑一个（最近/次数多的优先） */
  seed(soulId, now = Date.now()) {
    const st = this.stateOf(soulId);
    if (st.goals.length) return st;
    const top = this.interests(soulId).sort((a, b) => (b.n || 0) - (a.n || 0) || (b.lastAt || 0) - (a.lastAt || 0))[0];
    if (!top?.topic) return st;
    st.goals.push({ topic: String(top.topic).slice(0, 40), stage: 0, createdAt: now, lastAt: now, nextAt: now + DAY });
    this.save(soulId, st);
    return st;
  }

  /** 查资料/记笔记时调用：推进目标并安排下一次复习 */
  observeTopic(soulId, topic, now = Date.now()) {
    const t = String(topic || '').trim().slice(0, 40);
    if (!t) return null;
    const st = this.stateOf(soulId);
    let goal = st.goals.find((g) => g.topic === t || g.topic.includes(t) || t.includes(g.topic));
    if (!goal) {
      if (st.goals.length >= this.cfg.maxGoals) st.goals.shift();
      goal = { topic: t, stage: 0, createdAt: now, lastAt: now, nextAt: 0 };
      st.goals.push(goal);
    }
    goal.stage = Math.min(INTERVALS.length, (Number(goal.stage) || 0) + 1);
    goal.lastAt = now;
    const days = INTERVALS[Math.min(Math.max(0, goal.stage - 1), INTERVALS.length - 1)] || this.cfg.defaultIntervalDays;
    goal.nextAt = now + days * DAY;
    this.save(soulId, st);
    return goal;
  }

  /** 到期的复习（先回忆，再决定要不要查） */
  due(soulId, now = Date.now()) {
    return this.stateOf(soulId).goals.filter((g) => Number(g.nextAt) <= now).sort((a, b) => a.nextAt - b.nextAt);
  }

  active(soulId) {
    return this.stateOf(soulId).goals.slice().sort((a, b) => b.lastAt - a.lastAt)[0] || null;
  }

  /** 提示词里的一段（她自己也看到） */
  line(soulId, now = Date.now()) {
    const d = this.due(soulId, now)[0];
    if (d) {
      return `【学习复习】你之前想弄懂「${d.topic}」（第 ${d.stage || 1} 次）。先别急着查：用自己的话想想你还记得什么、哪些地方不确定；想完再决定要不要查资料。`;
    }
    const a = this.active(soulId);
    if (a) return `【学习目标】你最近在弄懂「${a.topic}」。下次复习在 ${Math.max(0, Math.ceil((a.nextAt - now) / DAY))} 天后。`;
    return '';
  }

  /** 调试/审计 */
  snapshot(soulId, now = Date.now()) {
    return { goals: this.stateOf(soulId).goals, due: this.due(soulId, now) };
  }
}
