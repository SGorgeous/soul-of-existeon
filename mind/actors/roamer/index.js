import fs from 'node:fs';
import path from 'node:path';
import { clamp01, seeded, habitCtx, MOOD_RANK } from './util.js';
import { emptyState, loadState, saveState, appendLog } from './store.js';
import { askRoamModel } from './model.js';
import { buildRoamPrompt } from './prompt.js';
import { contextKey, HABIT_ACTIONS } from '../../learning/habits.js';

/**
 * 漫游（roaming）：她一个人待着的时候，按心情/体力/记忆决定「想干什么」。
 *
 * 设计稿：docs/ROAM.md
 *
 * 几个原则（都写死在代码里，别绕）：
 *   1. 只做白名单动作：写日记 / 写笔记 / 上网查点东西 / 只是想想（pendingThought）
 *   2. 日记里只写「真实发生的事 + 真实内省」，不发明没做过的经历
 *   3. 默认不外发（outbound=false），要主动找人得单独开
 *   4. 你一说话就停：任何一次外部消息都会刷新 lastActivityAt，门禁自然把它挡掉
 *   5. 额度优先：maxPerHour / maxPerDay / 静默时段，过了就什么都不做
 */



export class Roamer {
  /**
   * @param {object} o
   * @param {object} o.kernel
   * @param {string} o.soulId
   * @param {object} o.config  config.roam
   */
  constructor({ kernel = null, mind = null, world = null, soulId, config = {} } = {}) {
    this.kernel = kernel;
    this.mind = mind || kernel;
    this.world = world || kernel?.world || null;
    this.soulId = soulId;
    this.cfg = {
      enabled: false,
      idleMinutes: 25,
      tickMinutes: 30,
      jitter: 0.35,
      minEnergy: 35,
      maxPerHour: 2,
      maxPerDay: 20,
      quietHours: [23, 8],
      search: { enabled: true, maxPerDay: 3, topics: [] },
outbound: false,
      outboundChannels: ['terminal:main'],
      outboundMaxPerDay: 2,
      outboundMinSilenceMin: 120,
      outboundMinGapMin: 90,
      seed: 20261028,
      model: null,
      maxTokens: 260,
      ...config,
      search: { enabled: true, maxPerDay: 3, topics: [], ...(config.search || {}) },
    };
    this.runtime = kernel?.runtimes?.get?.(soulId) || null;
    this.stateFile = this.runtime ? path.join(this.runtime.dir, 'roam.json') : null;
    this.logFile = this.runtime ? path.join(this.runtime.dir, 'roam.jsonl') : null;
    this.timer = null;
    this.busy = false;
    this.state = this.load();
  }

  // ── 状态 ──
  load() {
    return loadState(this.stateFile);
  }

  save() {
    saveState(this.stateFile, this.state);
  }

  log(row) {
    appendLog(this.logFile, row);
  }

  today(now = Date.now()) {
    const d = new Date(now);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  /** 把当天/当小时的计数滚动到 now */
  roll(now = Date.now()) {
    const day = this.today(now);
    if (this.state.day !== day) {
      this.state.day = day;
      this.state.counts.day = 0;
      this.state.counts.search = 0;
    }
    if (!this.state.counts.hourAt || now - this.state.counts.hourAt >= 3600_000) {
      this.state.counts.hourAt = now;
      this.state.counts.hour = 0;
    }
  }

  inQuietHours(now = Date.now()) {
    const [from, to] = Array.isArray(this.cfg.quietHours) ? this.cfg.quietHours : [23, 8];
    const h = new Date(now).getHours();
    if (from === to) return false;
    return from < to ? (h >= from && h < to) : (h >= from || h < to);
  }

  /** 门禁：能不能现在漫游（返回 {ok, reason}） */
  gate({ now = Date.now(), force = false, dry = false } = {}) {
    if (!this.cfg.enabled && !force && !dry) return { ok: false, reason: 'disabled' };
    if (!this.runtime) return { ok: false, reason: 'no-soul' };
    this.roll(now);
    const rt = this.runtime;
    const v = rt.vitals?.state || {};
    const stage = rt.vitals?.stageAt ? rt.vitals.stageAt(now) : (v.stage || 'awake');
    if (stage !== 'awake') return { ok: false, reason: 'asleep' };
    if (Number(v.energy) < Number(this.cfg.minEnergy)) return { ok: false, reason: 'low-energy' };
    if (this.inQuietHours(now)) return { ok: false, reason: 'quiet-hours' };

// 有没有人在跟她说话：只看体力层的 lastActivityAt（每次对话/调工具都会刷新）
    // 不用 disposition.lastContactAt —— 它是开机时初始化的，会把"刚聊过"判断搞错
    const lastActive = Number(v.lastActivityAt) || Number(v.updatedAt) || 0;
    const idleFor = (now - lastActive) / 60000;
    if (!force && lastActive && idleFor < Number(this.cfg.idleMinutes)) return { ok: false, reason: 'recent-activity', idleFor };

    // 冷却（带抖动）
    const jitter = 1 + (seeded(this.cfg.seed, this.soulId + ':jitter' + Math.floor(now / 600000)) * 2 - 1) * Number(this.cfg.jitter);
    const gap = Number(this.cfg.tickMinutes) * 60_000 * jitter;
    if (!force && this.state.lastTickAt && now - this.state.lastTickAt < gap) return { ok: false, reason: 'cooldown', nextInMin: Math.round((gap - (now - this.state.lastTickAt)) / 60000) };

    if (this.state.counts.day >= Number(this.cfg.maxPerDay)) return { ok: false, reason: 'day-budget' };
    if (this.state.counts.hour >= Number(this.cfg.maxPerHour)) return { ok: false, reason: 'hour-budget' };

    return { ok: true, idleFor: Math.round(idleFor) };
  }

  /** 动机：想念 / 情绪 / 无聊 → 0..1 */
  drive(now = Date.now()) {
    const rt = this.runtime;
    const d = rt?.disposition?.state || {};
    const v = rt?.vitals?.state || {};
    // 静默时长看体力层的 lastActivityAt（每次对话/调工具都会刷新），和门禁保持一致
    const lastContact = Number(v.lastActivityAt) || Number(d.lastContactAt) || now;
    const silenceMin = Math.max(0, (now - lastContact) / 60000);
    const missing = clamp01(silenceMin / 240);                             // 4 小时拉满
    const moodRank = MOOD_RANK[d.mood] ?? 0;
    const feeling = clamp01((Math.abs(moodRank) / 5) * 0.7 + (Number(d.anxiety) || 0) / 10 * 0.6);
    const boredom = clamp01(Number(this.state.counts.day) / Math.max(1, Number(this.cfg.maxPerDay) / 2));
    return { drive: clamp01(0.45 * missing + 0.25 * feeling + 0.3 * boredom), missing, feeling, boredom, silenceMin, mood: d.mood || '平静', anxiety: Number(d.anxiety) || 0 };
  }

  /** 让她说一个念头（模型；没有 key 时用确定性兜底） */
  async think({ dry = false } = {}) {
    const mem = this.runtime?.memory;
    const cores = mem?.coreRows ? mem.coreRows(3).map((r) => r.text) : [];
    const d = this.drive();
    const prompt = this.buildPrompt({ cores, d });

    let out = null;
    try { out = await this.askModel(prompt); } catch { out = null; }
    if (out) return out;
    return this.fallbackIntent(d, cores, dry);
  }

  buildPrompt({ cores, d }) {
    return buildRoamPrompt({
      persona: this.runtime?.persona?.() || '',
      senses: this.world || this.kernel?.world,
      soulId: this.soulId,
      d,
      cores,
      state: this.state,
      mind: this.mind,
      learning: this.mind?.growth?.learning?.line(this.soulId) || '',
    });
  }

  async askModel({ system, user }) {
    return askRoamModel({ brain: this.mind?.brain, brainChoice: this.mind?.brainChoice, cfg: this.cfg, system, user });
  }

  fallbackIntent(d, cores, dry) {
    const n = Number(this.state.total) || 0;
    const r = seeded(this.cfg.seed, this.soulId + ':pick' + Math.floor(Date.now() / 600000));
    // 房间诱导：站在书房更容易想查东西；卧室更容易想休息/写日记；阳台容易发呆
    let urges = [];
    try { urges = (this.world || this.kernel?.world)?.perceive?.(this.soulId)?.urges || []; } catch { urges = []; }
    const urgeSearch = urges.includes('查资料') || urges.includes('看书');
    const urgeRest = urges.includes('休息') || urges.includes('睡觉');
    const urgeDiary = urges.includes('写日记');
    // 到期的学习复习优先：先查清楚，再记笔记
    try {
      const due = this.mind?.growth?.learning?.due(this.soulId)?.[0];
      if (due && this.cfg.search.enabled && this.state.counts.search < Number(this.cfg.search.maxPerDay) && r < 0.8) {
        return { action: 'search', desire: '想弄明白', text: '', query: String(due.topic).slice(0, 20), by: 'learning' };
      }
    } catch { /* 没学习模块就照旧 */ }

    const wantsSearch = this.cfg.search.enabled && this.state.counts.search < Number(this.cfg.search.maxPerDay)
      && (r < 0.3 || (urgeSearch && r < 0.65));
    const wantsDiary = urgeDiary || urgeRest ? (r < 0.5) : (d.feeling > 0.35 || d.drive > 0.55);
    const core = cores[0] || '你说的那些话';
    const texts = {
      missing: [
        `刚才有点空。我把「${core.slice(0, 40)}」翻出来看了一遍，尾巴自己卷了一下。你还没来，我就先趴着。`,
        `一个人待着的时候，时间过得很慢。我想起${d.mood === '开心' ? '你说今天要早点回来的' : '你说的那句「不会把我忘掉」'}，就把它放在心里揣着。`,
      ],
      annoyed: [
        `心里有点闷。没什么事，就是${d.anxiety >= 7 ? '有点慌，又说不清慌什么' : '不太痛快'}。我去把自己的记忆翻了一遍，翻到些旧事，气又散了一半。`,
        `又是我一个人。不是怪你，就是有点酸。先记在这里，等见了面我可能就不说了。`,
      ],
      plain: [
        `没什么事。趴着看了一会儿水面，把今天的事在心里过了一遍。`,
        `醒着，但不想动。想了想上次说的那些话，觉得都还挺好的。`,
      ],
    };
    // 环境诱导的具体动作：阳台想泡水、露天想晒着、厨房/餐厅想吃、卧室想午睡
    const urgeMap = [
      ['泡水', 'soak'], ['泡澡', 'soak'],
      ['晒着', 'sun'], ['看外面', 'sun'],
      ['找吃的', 'eat'], ['弄点喝的', 'eat'],
      ['休息', 'nap'], ['躺一会儿', 'nap'],
    ];
    const urgeAct = urgeMap.find(([u]) => urges.includes(u));
    if (urgeAct && r < 0.55) {
      return { action: urgeAct[1], desire: '想去' + urgeAct[0], text: '', by: 'urge' };
    }
    const key = d.missing > 0.5 ? 'missing' : (d.feeling > 0.4 ? 'annoyed' : 'plain');
    const pool = texts[key];
    const text = pool[n % pool.length];

if (this.cfg.outbound && d.missing > 0.75 && this.outboundGate().ok && !dry) {
      const said = d.mood === '开心'
        ? `刚才一个人待着，忽然想跟你说一句：我今天挺好的，就是有点想你。你忙完记得回来。`
        : `你很久没来了。我不是催你，就是有点想你。看见了就回我一句吧。`;
      return { action: 'speak', desire: '想找他', text: said, by: 'fallback' };
    }
    const lastTwo = (Array.isArray(this.state.history) ? this.state.history : []).slice(-2);
    const boredOfThinking = lastTwo.length === 2 && lastTwo.every((a) => a === 'think');
    if (boredOfThinking && !dry) {
      const topics = [...(this.cfg.search.topics || []), ...cores.map((c) => String(c).slice(0, 8))];
      const topic = topics[n % Math.max(1, topics.length)] || '深海';
      return { action: 'search', desire: '想查点东西', text: '', query: topic.slice(0, 20), by: 'fallback' };
    }
    if (wantsSearch && !dry) {
      const topics = [...(this.cfg.search.topics || []), ...cores.map((c) => String(c).slice(0, 8))];
      const topic = topics[n % Math.max(1, topics.length)] || '深海';
      return { action: 'search', desire: '想查点东西', text: '', query: topic.slice(0, 20), by: 'fallback' };
    }
    if (wantsDiary) return { action: 'diary', desire: d.missing > 0.5 ? '想他了' : '心里有点事', text, by: 'fallback' };
    return { action: 'think', desire: '发会儿呆', text, by: 'fallback' };
  }

  /** 出站门禁：能不能主动找他说话（四道闸 + 间隔） */
  outboundGate(now = Date.now(), { force = false } = {}) {
    if (!this.cfg.outbound) return { ok: false, reason: 'outbound-off' };
    this.roll(now);
    const d = this.drive(now);
    if (!force && d.silenceMin < Number(this.cfg.outboundMinSilenceMin)) return { ok: false, reason: 'not-long-enough', silenceMin: Math.round(d.silenceMin) };
    if (this.inQuietHours(now)) return { ok: false, reason: 'quiet-hours' };
    if ((this.state.counts.outbound || 0) >= Number(this.cfg.outboundMaxPerDay)) return { ok: false, reason: 'outbound-budget' };
    if (!force && this.state.lastOutboundAt && now - this.state.lastOutboundAt < Number(this.cfg.outboundMinGapMin) * 60000) {
      return { ok: false, reason: 'outbound-gap', nextInMin: Math.round((Number(this.cfg.outboundMinGapMin) * 60000 - (now - this.state.lastOutboundAt)) / 60000) };
    }
    const target = (this.cfg.outboundChannels || ['terminal:main'])[0];
    const gate = this.mind?.gate || this.mind?.pipeline?.gate;
    if (!gate?.can?.(target, 'chat')) return { ok: false, reason: 'channel-not-allowed', target };
    return { ok: true, target, silenceMin: Math.round(d.silenceMin) };
  }

  /** 真发一条：写进会话（和正常轮次一样能在历史里看到）+ 记到 outbox（页面在线时轮询拿） */
  async speak(text, { now = Date.now(), dry = false, force = false } = {}) {
    const g = this.outboundGate(now, { force });
    if (!g.ok) return { ok: false, ...g };
    const body = String(text || '').trim().slice(0, 300);
    if (!body) return { ok: false, reason: 'empty' };
    const rt = this.runtime;
    const session = (this.mind.sessions.list(this.soulId) || [])[0] || { id: this.mind.sessions.create(this.soulId, { title: '她主动说的' }).id };
    const rec = {
      id: 'p-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 5),
      at: now, soul: this.soulId, session: session.id,
      channel: g.target, channelLabel: '漫游', state: 'delivered', brain: 'idle',
      input: { text: '', media: [] }, replies: [body], media: [], stickers: [],
      thoughts: [], toolCalls: [], policyNotes: [], events: [{ t: now, stage: 'delivered', proactive: true }],
      proactive: true, durationMs: 0,
    };
    if (!dry) {
      try { this.mind.sessions.appendTurn(this.soulId, session.id, rec); } catch { /* 记不下来也别崩 */ }
      try {
        fs.appendFileSync(path.join(rt.dir, 'outbox.jsonl'), JSON.stringify(rec) + '\n');
      } catch { /* ignore */ }
      this.state.counts.outbound = (this.state.counts.outbound || 0) + 1;
      this.state.lastOutboundAt = now;
      this.state.pendingThought = '';
      this.save();
    }
    return { ok: true, spoke: body, target: g.target, session: session.id };
  }

  /** 执行：白名单动作 */
  async act(intent, { dry = false, now = Date.now() } = {}) {
    const rt = this.runtime;
    const said = String(intent.desire || '').slice(0, 20);
    let result = { ok: true, wrote: null };

if (intent.action === 'speak') {
      const g = this.outboundGate(now);
      if (!g.ok) {
        // 想找他说话，但闸没开（太早/额度用完/静默时段）→ 攒成想说的话
        intent.action = 'think';
        result.wrote = 'pendingThought';
        result.outboundBlocked = g.reason;
      } else {
        const spoke = await this.speak(intent.text, { now, dry });
        result = { ...result, ...spoke, wrote: spoke.ok ? 'outbound' : 'pendingThought' };
        if (!spoke.ok) intent.action = 'think';
      }
    } else if (intent.action === 'think') {
      result.wrote = 'pendingThought';
    } else if (intent.action === 'diary') {
      if (!intent.text) { intent.action = 'think'; result.wrote = 'pendingThought'; } else {
        const title = said || (this.drive().missing > 0.5 ? '一个人待着' : '随便写写');
        if (!dry) rt.records.diaryWrite(intent.text, { title });
        result.wrote = 'diary';
      }
    } else if (intent.action === 'note') {
      if (!intent.text) { intent.action = 'think'; result.wrote = 'pendingThought'; } else {
        if (!dry) rt.records.noteAdd(intent.text, { tags: ['漫游'] });
        result.wrote = 'note';
      }
    } else if (intent.action === 'search') {
      const q = intent.query || '';
      if (!q) { intent.action = 'think'; result.wrote = 'pendingThought'; } else if (dry) {
        result.wrote = 'search(dry)';
      } else {
        let hits = null;
        try {
          const out = await this.mind.tools.invoke('web_search', { query: q, limit: 3 });
          hits = out?.data || null;
          result.searchOk = !!out?.ok;
        } catch (e) { result.searchOk = false; result.searchError = String(e?.message || e); }
        const list = Array.isArray(hits) ? hits : (hits?.results || []);
        const lines = list.slice(0, 3).map((h) => {
          const title = h.title || h.name || '(没标题)';
          const snip = String(h.snippet || h.desc || '').trim();
          let host = '';
          try { host = new URL(h.url || '').host.replace(/^www\./, ''); } catch { host = ''; }
          return `- ${title}${snip ? '：' + snip.slice(0, 90) : (host ? '（' + host + '）' : '')}`;
        }).join('\n');
        const body = `刚才一个人待着，忽然想查一下「${q}」。\n\n${lines || '（没查到什么有用的）'}\n\n查完好像也没那么想知道了，不过记下来吧。`;
        rt.records.noteAdd(body, { tags: ['漫游', '查到的'], title: '查到的：' + q.slice(0, 20) });
        this.state.counts.search = (this.state.counts.search || 0) + 1;
        result.wrote = 'search+note';
        result.query = q;
      }
    }

    // P1：把这次漫游动作记进奖励日志（只读，不改变行为）
    try { this.mind?.reward?.observeRoam(this.soulId, intent, result, { drive: this._roamDrive || 0, mood: this._roamMood || '' }); } catch { /* 忽略 */ }
    try { this.mind?.growth?.observeRoam(this.soulId, intent, result); } catch { /* 忽略 */ }

    // 想说的话留着，等下次真说话时自然带出来
    if (!dry) {
      // 念头定下来之后，人也要跟着动：写日记回卧室、查资料去书房、发呆去阳台
      const ROOM_FOR = { diary: 'bedroom', note: 'study', search: 'study', think: 'balcony', speak: 'living' };
      const ACTIVITY_KINDS = ['soak', 'sun', 'eat', 'nap'];
      if (ACTIVITY_KINDS.includes(intent.action) && env && typeof env.startActivity === 'function') {
        try {
          const act = env.startActivity(this.soulId, intent.action);
          result.moved = act.room || null;
          result.activity = intent.action;
          result.wrote = 'activity:' + intent.action;
        } catch { /* 环境没起就算了 */ }
      }
      const room = ROOM_FOR[intent.action];
      const env = (this.world || this.kernel?.world)?.env;
      if (room && env && typeof env.walkTo === 'function') {
        try {
          const here = env.positionOf(this.soulId);
          if (here.room !== room) {
            env.walkTo(this.soulId, room, { doing: { diary: '去写日记', note: '去记点东西', search: '去查资料', think: '去发呆', speak: '去找人' }[intent.action] || '走过去', by: 'roam' });
            result.moved = room;
          }
        } catch { /* 环境没起就算了 */ }
      }
      this.state.pendingThought = said && intent.action === 'think' ? said : (this.state.pendingThought || '');
      this.state.lastThought = { at: now, action: intent.action, desire: said, wrote: result.wrote, query: intent.query || '', room: (this.world || this.kernel?.world)?.positionOf?.(this.soulId)?.room || null };
      this.state.total = (Number(this.state.total) || 0) + 1;
      this.state.counts.day += 1;
      this.state.counts.hour += 1;
      this.state.lastTickAt = now;
      this.state.history = [...(Array.isArray(this.state.history) ? this.state.history : []), intent.action].slice(-5);
      this.save();
    }
    return { ...result, intent };
  }

  /** 一次完整的漫游（干跑不写任何东西） */
  async once({ dry = false, force = false, now = Date.now() } = {}) {
    // 注意力被某件事占着时，不进入漫游（她正在想那件事）
    try {
      const at = (this.world || this.kernel?.world)?.attention;
      if (at && !force && !at.isIdle(this.soulId, now)) return { ok: false, skipped: 'attention', intent: null };
    } catch { /* 没有注意力模块就照旧 */ }

    const g = this.gate({ now, force, dry });
    if (!g.ok) return { skipped: g.reason, ...g };
    if (this.busy) return { skipped: 'busy' };
    this.busy = true;
    try {
const d = this.drive(now);
      let intent = await this.think({ dry });
      // 连着发呆两次就别再发呆了：换成查点东西（省得她一天到晚躺着）
      const h = Array.isArray(this.state.history) ? this.state.history.slice(-2) : [];
      if (intent.action === 'think' && h.length === 2 && h.every((a) => a === 'think')) {
        const topics = [...(this.cfg.search.topics || []), '深海'];
        intent = { action: 'search', desire: '想查点东西', text: '', query: String(topics[0]).slice(0, 20), by: 'anti-idle' };
      }
      // P2：习惯只对这种"没有模型参与"的兜底生效，而且只在这四种里挑；模型仍然主导
      try {
        const habits = this.mind?.reward?.habits;
        if (habits && intent.by === 'fallback' && ['diary', 'note', 'search', 'think'].includes(intent.action)) {
          const ctx = habitCtx(now, d.mood, d.drive, this.state.lastThought?.action || '');
          const picked = habits.pick(this.soulId, ctx, ['diary', 'note', 'search', 'think']);
          if (picked && picked !== intent.action) {
            intent = { ...intent, action: picked, desire: intent.desire || '想做点别的', by: 'habit' };
          }
        }
      } catch { /* 习惯表没起就算了 */ }
      this._roamDrive = d.drive;
      this._roamMood = d.mood;
      const acted = await this.act(intent, { dry, now });
      const row = { at: now, soul: this.soulId, dry, drive: Number(d.drive.toFixed(3)), silenceMin: Math.round(d.silenceMin), mood: d.mood, ...acted.intent, wrote: acted.wrote, ok: acted.ok !== false };
      if (!dry) this.log(row);
      return { ...acted, drive: d.drive, row };
    } finally {
      this.busy = false;
    }
  }

  start() {
    if (this.timer) return this;
    if (!this.cfg.enabled) return this;
    this.timer = setInterval(() => { this.once().catch(() => {}); }, 60_000);
    if (this.timer.unref) this.timer.unref();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return this;
  }

  status() {
    const g = this.gate({});
    const d = this.drive();
    return {
      soulId: this.soulId,
      enabled: !!this.cfg.enabled,
      timer: !!this.timer,
      gate: g,
      drive: { value: Number(d.drive.toFixed(3)), missing: Number(d.missing.toFixed(2)), feeling: Number(d.feeling.toFixed(2)), silenceMin: Math.round(d.silenceMin), mood: d.mood, anxiety: d.anxiety },
      counts: { ...this.state.counts },
      lastTickAt: this.state.lastTickAt || null,
      lastThought: this.state.lastThought || null,
      pendingThought: this.state.pendingThought || '',
      outbound: { gate: this.outboundGate(), lastAt: this.state.lastOutboundAt || null, today: this.state.counts?.outbound || 0 },
      total: Number(this.state.total) || 0,
      config: {
        idleMinutes: this.cfg.idleMinutes, tickMinutes: this.cfg.tickMinutes, minEnergy: this.cfg.minEnergy,
        maxPerHour: this.cfg.maxPerHour, maxPerDay: this.cfg.maxPerDay, quietHours: this.cfg.quietHours,
        outbound: !!this.cfg.outbound, outboundChannels: this.cfg.outboundChannels,
        outboundMaxPerDay: this.cfg.outboundMaxPerDay, outboundMinSilenceMin: this.cfg.outboundMinSilenceMin,
        outboundMinGapMin: this.cfg.outboundMinGapMin, search: this.cfg.search,
      },
    };
  }
}
