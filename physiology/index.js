import fs from 'node:fs';
import path from 'node:path';
import { readJson } from '../core/read.js';

const clamp = (n) => Math.max(0, Math.min(100, n));
const STAGES = ['awake', 'n1', 'n2', 'n3', 'rem'];

/**
 * 生理层：体力 / 精力 / 睡眠阶段（N1/N2/N3/REM）/ REM 被强行打断的惩罚 / 反应力。
 * P0 只做 Gate 需要的部分；这里补上睡眠分期与 REM 惩罚。
 *
 * 一个灵魂一份（`state/souls/<id>/vitals.json`）：水伊布聊累了，仙子伊布不该跟着累。
 * 不传 stateFile 就落在老的全局 `state/vitals.json`（单测和旧调用还能用）。
 */
export class Vitals {
  constructor({ root, config = {}, stateFile = null } = {}) {
    this.root = root || process.cwd();
    this.cfg = {
      sleepStart: '23:30',
      sleepEnd: '08:00',
      drainEnergyPerMin: 0.5,
      drainFocusPerMin: 0.8,
      recoverEnergyPerMin: 2.0,
      recoverFocusPerMin: 1.5,
      minEnergy: 10,
      minFocus: 10,
      reactionMin: 0.15,
      // 一个睡眠周期 90 分钟：N1 7 + N2 33 + N3 35 + REM 15
      n1Minutes: 7,
      n2Minutes: 33,
      n3Minutes: 35,
      remMinutes: 15,
      remWakeEnergy: 8,
      remWakeFocus: 12,
      // 停机/没人理：一次最多补算这么多分钟，别把冷启动的整段时间都算成清醒消耗
      maxCatchUpMinutes: 5,
      // 睡着/闲着回血时最多按这么久算（睡一夜就该睡饱，但别把「关机一个月」也算成休假）
      maxRecoverMinutes: 720,
      // 醒着但闲着超过这么久 → 开始回血（不然白天一口气用完就永远哑了）
      idleRecoverAfterMin: 10,
      idleRecoverEnergyPerMin: 2.0,
      idleRecoverFocusPerMin: 1.5,
      ...config,
    };
    this.file = stateFile || path.join(this.root, 'state', 'vitals.json');
    this.state = {
      energy: 100, focus: 100, stage: 'awake', resting: false,
      remStartedAt: null, forcedWakeCount: 0, updatedAt: Date.now(), lastActivityAt: Date.now(),
    };
    this.saveAt = 0;
    this.load();
  }

  load() {
    try {
      const j = readJson(this.file);
      this.state = { ...this.state, ...j, stage: this.stageAt(Date.now()) };
    } catch { /* 首次 */ }
  }

  save() {
    const now = Date.now();
    if (now - this.saveAt < 1000) return;
    this.saveAt = now;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2));
    } catch { /* 记不下来不影响对话 */ }
  }

  minutesOf(hhmm) {
    const [h, m] = String(hhmm || '00:00').split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  }

  cycleMinutes() {
    return this.cfg.n1Minutes + this.cfg.n2Minutes + this.cfg.n3Minutes + this.cfg.remMinutes;
  }

  /** 距离「今天这次入睡」过了多少分钟；不在睡眠窗口返回 null。窗口支持跨零点。 */
  minutesSinceSleepStart(now = Date.now()) {
    const d = new Date(now);
    const cur = d.getHours() * 60 + d.getMinutes();
    const start = this.minutesOf(this.cfg.sleepStart);
    const end = this.minutesOf(this.cfg.sleepEnd);
    if (start === end) return null;
    if (start < end) return cur >= start && cur < end ? cur - start : null;
    if (cur >= start) return cur - start;
    if (cur < end) return 1440 - start + cur;
    return null;
  }

  /** 睡眠分期：第一周期含 N1，之后按 N2 → N3 → REM 循环。 */
  stageAt(now = Date.now()) {
    // debug 里「叫醒一会儿」：在窗口内强制算清醒，免得半夜想测却一直是 asleep
    if (this.state.awakeUntil && now < this.state.awakeUntil) return 'awake';
    const since = this.minutesSinceSleepStart(now);
    if (since == null) return 'awake';
    const { n1Minutes: n1, n2Minutes: n2, n3Minutes: n3 } = this.cfg;
    const cycle = this.cycleMinutes();
    const idx = Math.floor(since / cycle);
    const t = since % cycle;
    if (idx === 0) {
      if (t < n1) return 'n1';
      if (t < n1 + n2) return 'n2';
      if (t < n1 + n2 + n3) return 'n3';
      return 'rem';
    }
    if (t < n2) return 'n2';
    if (t < n2 + n3) return 'n3';
    return 'rem';
  }

  tick(now = Date.now()) {
    const prev = this.state.stage;
    const stage = this.stageAt(now);
    const rawDt = Math.max(0, (now - this.state.updatedAt) / 60000);
    const sinceActivity = Math.max(0, (now - (this.state.lastActivityAt || this.state.updatedAt)) / 60000);
    this.state.stage = stage;
    if (stage === 'rem' && prev !== 'rem') this.state.remStartedAt = now;
    if (stage !== 'rem' && prev === 'rem') this.state.remStartedAt = null;
    // 睡着 或 醒着但闲着够久 → 回血；正好在说话 → 扣体力
    const resting = stage !== 'awake' || sinceActivity >= this.cfg.idleRecoverAfterMin;
    this.state.resting = resting;
    // 回血要按整段时间算（睡一夜就该睡饱）；但「一直在干活」的补算要封顶，
    // 免得重启时把停机的一整段当成她在消耗
    const dt = Math.min(rawDt, resting ? this.cfg.maxRecoverMinutes : this.cfg.maxCatchUpMinutes);
    if (dt > 0) {
      if (resting) {
        const addEnergy = (stage === 'awake' ? this.cfg.idleRecoverEnergyPerMin : this.cfg.recoverEnergyPerMin) * dt;
        const addFocus = (stage === 'awake' ? this.cfg.idleRecoverFocusPerMin : this.cfg.recoverFocusPerMin) * dt;
        this.state.energy = clamp(this.state.energy + addEnergy);
        this.state.focus = clamp(this.state.focus + addFocus);
      } else {
        this.state.energy = clamp(this.state.energy - this.cfg.drainEnergyPerMin * dt);
        this.state.focus = clamp(this.state.focus - this.cfg.drainFocusPerMin * dt);
      }
    }
    this.state.updatedAt = now;
    return this.state;
  }

  charge(kind = 'send', now = Date.now()) {
    this.tick(now);
    const cost = { send: 1.0, tool: 2.0, think: 0.5 }[kind] ?? 0.5;
    this.state.energy = clamp(this.state.energy - cost * 0.5);
    this.state.focus = clamp(this.state.focus - cost);
    // 有事做 → 不算闲着；只有睡着才算休息
    this.state.lastActivityAt = now;
    this.state.resting = this.state.stage !== 'awake';
    this.save();
    return this.state;
  }

  reaction() {
    return Math.max(0, Math.min(1, (this.state.energy * 0.6 + this.state.focus * 0.4) / 100));
  }

  /**
   * 睡眠中收到任何东西都会被叫醒；如果正在 REM：
   * 体力/精力恢复被截断 + 直接扣一截 + 记一次 forcedWake。
   */
  check(now = Date.now()) {
    const prev = this.state.stage;
    this.tick(now);
    const s = this.state;
    const base = { stage: s.stage, energy: s.energy, focus: s.focus, reaction: this.reaction(), resting: !!s.resting };
    if (s.stage === 'rem') {
      s.energy = clamp(s.energy - this.cfg.remWakeEnergy);
      s.focus = clamp(s.focus - this.cfg.remWakeFocus);
      s.stage = 'awake';
      s.forcedWakeCount += 1;
      s.remStartedAt = null;
      this.save();
      return { ok: false, reason: 'rem-interrupted', ...base, stage: 'awake', energy: s.energy, focus: s.focus, reaction: this.reaction(), prevStage: prev };
    }
    if (s.stage !== 'awake') {
      return { ok: false, reason: 'asleep', ...base };
    }
    if (s.energy < this.cfg.minEnergy) {
      return { ok: false, reason: 'low-energy', ...base };
    }
    if (s.focus < this.cfg.minFocus) {
      return { ok: false, reason: 'low-focus', ...base };
    }
    return { ok: true, reason: null, ...base };
  }

  health() {
    return {
      energy: Number(this.state.energy.toFixed(1)),
      focus: Number(this.state.focus.toFixed(1)),
      stage: this.state.stage,
      sleepStage: this.state.stage,
      resting: !!this.state.resting,
      reaction: Number(this.reaction().toFixed(2)),
      forcedWakeCount: this.state.forcedWakeCount,
      idleMinutes: Math.round(((Date.now() - (this.state.lastActivityAt || this.state.updatedAt)) / 60000) * 10) / 10,
      window: `${this.cfg.sleepStart}-${this.cfg.sleepEnd}`,
    };
  }
}

export { STAGES };
