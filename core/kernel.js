import fs from 'node:fs';
import path from 'node:path';
import { Gate } from './gate.js';
import { Pipeline } from './pipeline.js';
import { Composer } from './compose.js';
import { Turn } from './turn.js';
import { Organ, Expects, act } from './contracts.js';
import { Reasoner } from '../mind/reasoner.js';
import { MockBrain, DeepseekBrain } from '../mind/brain.js';
import { ToolRegistry } from '../tools/index.js';
import { registerBuiltins } from '../tools/builtin.js';
import { Souls } from './souls.js';
import { Sessions } from './sessions.js';
import { SoulRuntimes } from './soul-runtime.js';
import { Reflection } from '../reflection/index.js';
import { Reflex } from '../mind/reflex/engine.js';
import { AutoLog } from '../mind/autolog.js';
import { Addressing } from '../core/addressing.js';
import { RewardEngine } from '../mind/learning/reward.js';
import { Growth } from '../mind/learning/growth.js';
import { EMOTION_FOR_MOOD } from '../mind/stickers.js';
import { Policy } from './policy.js';
import { readUtf8 } from './read.js';
import { Roamer } from '../mind/actors/roamer.js';

/** 内核：把 Turn + 各阶段接起来，不含任何通道细节。 */
export class Kernel {
  constructor({ root = process.cwd(), config = {} } = {}) {
    this.root = root;
    this.config = config;
    this.turns = [];
    this.turnIndex = new Map();
    this.adapters = [];
    this.startedAt = Date.now();
    this.metrics = { turns: 0, failures: 0, totalMs: 0, tools: 0, toolFails: 0 };

    this.vitalsConfig = config.vitals || {};
    this.tools = new ToolRegistry({ timeoutMs: config.tools?.timeoutMs || 15000 });
    this.souls = new Souls({ root });
    this.sessions = new Sessions({ root });
    this.runtimes = new SoulRuntimes({ root, config });
    this.defaultSoul = this.runtimes.defaultId;
    this.reflection = new Reflection({ root, ...(config.reflection || {}) });
    this.reflex = new Reflex({ root, config: config.reflex || {} });
    this.autolog = new AutoLog({ root, config: config.autolog || {} });
    this.reward = new RewardEngine({ root, config: config.reward || {} });
    this.growth = new Growth({ root, config: config.growth || {} });
    this.runtimes.growth = this.growth;
    this.addressingCfg = config.addressing || {};
    this.lastMedia = [];
    registerBuiltins({
      tools: this.tools, kernel: this,
      scope: () => this.stores(),
      vision: config.vision || {},
    });

    this.brainChoice = this.pickBrain(config);
    this.brain = this.brainChoice.deepseek
      ? new DeepseekBrain({
        apiKey: this.brainChoice.key,
        model: config.brain?.model || 'deepseek-chat',
        base: config.brain?.base,
        timeoutMs: config.brain?.timeoutMs || 45000,
      })
      : new MockBrain();

    this.currentTurn = null;
    this.pipeline = new Pipeline({
      gate: new Gate({
        config: config.gate || {},
        vitals: config.gate?.checkVitals === false ? null : (turn) => this.vitalsFor(turn),
      }),
      context: { build: (turn) => this.runtimes.get(turn.soul || this.defaultSoul).context.build(turn) },
      reasoner: new Reasoner({ brain: this.brain, tools: this.tools, ...(config.reasoner || {}) }),
      composer: new Composer({ ...(config.compose || {}) }),
      policy: new Policy({ config: config.behavior || {} }),
      reflex: this.reflex,
// 「这句是在跟我说吗」：群里没点名就不回（不耗模型）
      addressing: {
        check: (turn) => {
          const rt = this.runtimes.get(turn.soul || this.defaultSoul);
          const addr = new Addressing({ config: this.addressingCfg });
          return addr.check(turn, rt ? [rt.name, rt.id] : []);
        },
      },
      // 倾向：按「这一轮是谁」去取那个人格的心情/喜恶（换灵魂就换脾气）
      disposition: {
        observe: (turn) => {
          const rt = this.runtimes.get(turn.soul || this.defaultSoul);
          if (!rt?.disposition) return null;
          const prevMood = rt.disposition.state.mood;
          const d = rt.disposition.notice(turn);
          return { ...d, prevMood };     // 带上「变之前」的心情，自动落日记要用
        },
      },
      deliver: { deliver: (turn, a) => this.deliver(turn, a) },
      post: {
        after: async (turn) => {
          // 漫游攒的那句话用掉了：投递成功就清掉，别下一轮又重复
          if (turn.pendingThought && turn.delivered) {
            const rm = this.roamers?.get?.(turn.soul);
            if (rm?.state) { rm.state.pendingThought = ''; try { rm.save(); } catch { /* ignore */ } }
          }
// 她没主动发表情、但情绪明显时，兜底挑一个（概率可配，默认 0.3）
          try { this.maybeAutoSticker(turn, this.runtimes.get(turn.soul || this.defaultSoul)); } catch { /* 不影响回复 */ }
          // 先判断这一轮值不值得记一笔（记忆/日记/笔记），再落盘，事件才会写进 turn 记录
          try {
            const rt = this.runtimes.get(turn.soul || this.defaultSoul);
            const rec = this.autolog.after(turn, rt);
            if (rec) turn.event('autolog', rec);
          } catch { /* 记不下来不影响回复 */ }
          this.recordTurn(turn);
          this.reflection.after(turn);
          try {
        const rt = this.runtimes.get(turn.soul || this.defaultSoul);
        if (rt) rt.people.recordTurn(turn, rt.name);
        // P1：只算分、只落盘，不改行为
        if (rt) this.reward.observeTurn(turn, { disposition: rt.disposition, persona: rt.context?.persona?.() || '' });
        if (rt) this.growth.observeTurn(turn, { persona: rt.context?.persona?.() || '' });
      } catch { /* 记不下来不影响回复 */ }
        },
      },
    });
  }

  /**
   * 大脑选择：显式 kind 优先；auto 时 EXISTEON_DS_KEY 存在用真模型、否则 mock。
   * forceMock 是给测试用的确定性开关。
   */
  pickBrain(config) {
    const key = process.env.EXISTEON_DS_KEY || config.brain?.apiKey || '';
    if (config.brain?.forceMock) return { deepseek: false, key: '' };
    const kind = config.brain?.kind || 'auto';
    if (kind === 'mock') return { deepseek: false, key: '' };
    if (kind === 'deepseek') return { deepseek: true, key };
    return { deepseek: !!key, key };
  }

  registerAdapter(adapter) {
    if (adapter && typeof adapter.deliver === 'function' && typeof adapter.matches === 'function') {
      this.adapters.push(adapter);
    }
    return adapter;
  }

  async deliver(_turn, a) {
    const adapter = this.adapters.find((x) => x.matches(String(a.target || '')));
    if (adapter) await adapter.deliver(_turn, a);
  }

  /** 工具 send_message 用：按目标通道投递（真实推送交给适配器）。 */
  async send(target, text) {    const t = String(target || '').trim();
    if (!t) return { ok: false, error: 'target 不能为空' };
    if (!String(text || '').trim()) return { ok: false, error: 'text 不能为空' };
    if (!this.pipeline.gate.can(t, 'chat')) return { ok: false, error: `目标 ${t} 没有 chat 权限` };
    const adapter = this.adapters.find((a) => a.matches(t));
    if (!adapter) return { ok: false, error: `没有适配器负责 ${t}` };
    await adapter.deliver(null, act({
      organ: Organ.SPEECH, target: t, payload: { text: String(text) },
      expects: Expects.NONE, causedBy: 'tool:send_message',
    }));
    return { ok: true, target: t };
  }

  /** 工具 send_sticker 用：只有实现了 sendSticker 的适配器能发；网页明确拒绝。 */
  async sendSticker(target, sticker) {
    const t = String(target || '').trim();
    if (!String(sticker || '').trim()) return { ok: false, error: 'sticker 不能为空' };
    if (!this.pipeline.gate.can(t, 'chat')) return { ok: false, error: `目标 ${t} 没有 chat 权限` };
    const adapter = this.adapters.find((a) => a.matches(t) && typeof a.sendSticker === 'function');
    if (!adapter) return { ok: false, error: `通道 ${t} 不支持表情（适配器未实现 sendSticker）` };
    return adapter.sendSticker(t, sticker);
  }

  /**
   * 一轮对话 = runOnce；如果她说了「我看看/稍等」，最多再续两轮把结论说完。
   * 续做产生的回复合并回第一轮，方便网页一次拿全。
   */
  async runTurn(input = {}) {
    // 人格与会话在这一层定下来，后面所有阶段都看 turn.soul / turn.session
    const soul = this.runtimes.resolve(input.soulId ?? input.soul ?? null);
    if (!soul) throw new Error('没有这个人格：' + (input.soulId || input.soul));
    const session = this.sessions.open(soul, input.sessionId ?? input.session ?? null);
    if (!session) throw new Error('会话 id 不合法（字母数字下划线短横，≤40）：' + (input.sessionId || input.session));
    const base = { ...input, soulId: soul, sessionId: session.id, stream: !!input.stream, onDelta: input.onDelta || null, onEvent: input.onEvent || null };

    const turn = await this.runOnce(base);
    const cfg = this.config.continuation || {};
    if (cfg.enabled === false) return turn;

    let re = null;
    try { re = new RegExp(cfg.pattern || '我看看|稍等|我查一下|等我查|稍后'); } catch { re = null; }
    if (!re) return turn;

    const max = Math.max(0, Number(cfg.max ?? 2));
    let n = Number(input.meta?.continuation || 0);
    let last = turn;
    while (n < max && last.delivered !== false && re.test(String((last.replies || []).slice(-1)[0] || ''))) {
      n += 1;
      const follow = await this.runOnce({
        ...base,
        text: cfg.prompt || '（继续：刚才你说要看看/稍等，现在把结论说出来，短一点）',
        meta: { ...(input.meta || {}), continuation: n },
        source: 'self',
      });
      turn.replies.push(...(follow.replies || []));
      turn.continuation = n;
      turn.event('continued', { n, replies: (follow.replies || []).length, delivered: follow.delivered });
      if (follow.delivered === false) break;
      last = follow;
    }
    return turn;
  }

  async runOnce({ channel = 'terminal:main', text = '', media = [], meta = {}, source = 'web', soulId = null, sessionId = null, stream = false, onDelta = null, onEvent = null } = {}) {
    const soul = this.runtimes.resolve(soulId) || this.defaultSoul;
    const runtime = this.runtimes.get(soul);
    if (!runtime) throw new Error('没有这个人格：' + soul);
    const turn = new Turn({ channel, text, media, meta, source, soul, session: sessionId || null });
    turn.brain = this.brainChoice.deepseek ? 'deepseek' : 'mock';
    // 流式（SSE）与阶段回调：只有显式要的时候才打开
    turn.stream = !!stream;
    turn.onDelta = typeof onDelta === 'function' ? onDelta : null;
turn.onEvent = typeof onEvent === 'function' ? onEvent : null;
    // 体力快照：条件反射要能在"精力低"时快速判断，不额外读盘
    try { const vs = this.runtimes.get(soul)?.vitals?.state; if (vs) turn.vitals = { energy: vs.energy, focus: vs.focus, stage: vs.stage }; } catch { /* 没体力层就算 */ }
    // 漫游时攒着没说的话：真人的消息来时带一句进去（别在漫游自己的轮次里重复自己）
    const roam = this.roamers?.get?.(soul);
    if (roam?.state?.pendingThought && !String(channel).startsWith('idle:')) turn.pendingThought = roam.state.pendingThought;
    this.currentTurn = turn;
    if (Array.isArray(media) && media.length) this.lastMedia = media;
    const fact = runtime.facts.extract(String(text || ''));
    if (fact) runtime.facts.add(fact);
    this.turns.push(turn);
    this.turnIndex.set(turn.id, turn);
    if (this.turns.length > 200) {
      this.turns = this.turns.slice(-200);
      for (const k of this.turnIndex.keys()) {
        if (!this.turns.some((t) => t.id === k)) this.turnIndex.delete(k);
      }
    }
    const out = await this.pipeline.run(turn);
    this.currentTurn = null;
    this.metrics.turns += 1;
    if (out.state === 'failed') this.metrics.failures += 1;
    this.metrics.totalMs += Number(out.durationMs) || 0;
    for (const c of out.toolCalls || []) { this.metrics.tools += 1; if (!c.result?.ok) this.metrics.toolFails += 1; }
    this.charge(out);
    return out;
  }

  /** 体力/精力消耗：被门禁豁免（debug）、被门禁拦下、或没真正发出（潜水/三思拦下）的轮次不扣。 */
  charge(turn) {
    if (!turn || turn.delivered === false) return;
    if (turn.events?.some((e) => e.skipped)) return;
    if (!turn || (turn.bypass || []).some((b) => b === 'all' || b === 'vitals')) return;
    if (turn.state === 'failed') return;
    const v = this.vitalsFor(turn);
    if (!v) return;
    v.charge('think');
    for (let i = 0; i < (turn.replies || []).length; i += 1) v.charge('send');
  }

  /**
   * 漫游：按 config.roam.souls 启动（默认只给默认灵魂）。
   * 设计稿 docs/ROAM.md —— 默认只写本地、不出声。
   */
  initRoamers() {
    const cfg = this.config.roam || {};
    this.roamers = new Map();
    if (!cfg.enabled) return 0;
    const souls = (Array.isArray(cfg.souls) && cfg.souls.length ? cfg.souls : [this.defaultSoul]).filter((id) => this.souls.exists(id));
    for (const id of souls) this.roamers.set(id, new Roamer({ kernel: this, mind: this, world: this.world, soulId: id, config: cfg }));
    for (const r of this.roamers.values()) r.start();
    return this.roamers.size;
  }

  /** 取某个灵魂的漫游器（没启动过就现建一个，方便调试/手动跑一次） */
  roamer(soulId = null) {
    const id = soulId || this.defaultSoul;
    if (!this.souls.exists(id)) return null;
    if (!this.roamers) this.roamers = new Map();
    if (!this.roamers.has(id)) this.roamers.set(id, new Roamer({ kernel: this, mind: this, world: this.world, soulId: id, config: this.config.roam || {} }));
    return this.roamers.get(id);
  }

  /** 装配世界端口：内核不再持有具体 Space/Environment，只认 WorldPort 接口 */
  bindWorld(world) {
    this.world = world;
    if (this.runtimes) this.runtimes.world = world;
    for (const id of this.souls.list()) {
      try {
        const rt = this.runtimes.get(id);
        if (rt?.context?.setWorld) rt.context.setWorld(world);
      } catch { /* 单个失败不影响 */ }
    }
    return this;
  }

  /** 情绪明显（焦虑高 / 心情负面）时兜底发一个表情包，别每轮都发 */
  maybeAutoSticker(turn, rt) {
    if (!rt?.stickers || (turn.stickers || []).length) return null;
    if (turn.skipped || !(turn.replies || []).length) return null;
    const cfg = this.config.stickers || {};
    const p = Number(cfg.autoOnStrongMood ?? 0.3);
    if (!(p > 0) || Math.random() > p) return null;
    const mood = String(turn.mood || '');
    const emotion = Number(turn.anxiety ?? 0) >= 6 ? 'worried' : EMOTION_FOR_MOOD[mood];
    if (!emotion || !rt.stickers.has(rt.id, emotion)) return null;
    const item = { emotion, url: '/sticker/' + encodeURIComponent(rt.id) + '/' + emotion + '.png', auto: true };
    turn.stickers.push(item);
    turn.event('sticker', item);
    return item;
  }

  /** 这一轮该用谁的体力：按 turn.soul 取那个灵魂的生理层；不传就用默认灵魂 */
  vitalsFor(turn = null) {
    const id = turn?.soul || this.currentTurn?.soul || this.defaultSoul;
    return this.runtimes.get(id)?.vitals || null;
  }

  /** 这一轮存到两处：全局 turns.jsonl（时间线）+ 该 soul 该会话的 turns.jsonl（聊天记录）。 */
  recordTurn(turn) {
    try { turn.person = this.runtimes.get(turn.soul || this.defaultSoul)?.people.personOf(turn.channel, turn.meta); } catch { /* 忽略 */ }
    turn.event('posted', { bytes: 0 });
    const json = turn.toJSON();
    try {
      const dir = path.join(this.root, 'state');
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, 'turns.jsonl'), JSON.stringify(json) + '\n');
    } catch { /* 记不下来不影响回复 */ }
    try {
      if (turn.session) {
        const meta = this.sessions.appendTurn(turn.soul || this.defaultSoul, turn.session, json);
        if (meta?.title) turn.sessionTitle = meta.title;
      }
    } catch { /* 会话写不下也不影响回复 */ }
  }

  /** 当前 soul 的存储（工具层用：memory / facts / records / people 都落到这一层）。 */
  stores(soulId) {
    const id = soulId || this.currentTurn?.soul || this.defaultSoul;
    return this.runtimes.get(id) || this.runtimes.get(this.defaultSoul);
  }

  /** 按 turn_id 找一轮：先内存（近 200），再回读 turns.jsonl。 */
  findTurn(id) {
    if (!id) return null;
    const mem = this.turnIndex.get(id);
    if (mem) return mem;
    try {
      const rows = readUtf8(path.join(this.root, 'state', 'turns.jsonl'))
        .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      return rows.reverse().find((t) => t.id === id) || null;
    } catch { return null; }
  }

  /** 合并「进程内」与「已落盘」的 Turn（重启后列表/追踪不空）。 */
  recentTurns(limit = 20) {
    const n = Math.max(1, Math.min(500, Number(limit) || 20));
    const map = new Map();
    try {
      const rows = readUtf8(path.join(this.root, 'state', 'turns.jsonl'))
        .trim().split('\n').filter(Boolean);
      for (const line of rows.slice(-2000)) {
        try { const r = JSON.parse(line); if (r?.id) map.set(r.id, r); } catch { /* 跳过坏行 */ }
      }
    } catch { /* 还没有 turns.jsonl */ }
    for (const t of this.turns) map.set(t.id, t.toJSON());
    return [...map.values()]
      .sort((a, b) => (a.at || 0) - (b.at || 0))
      .slice(-n);
  }

  health(soulId = null) {
    const rt = (soulId && this.runtimes.get(soulId)) || this.stores();
    return {
      ok: true,
      uptimeMs: Date.now() - this.startedAt,
      brain: this.brainChoice.deepseek ? 'deepseek' : 'mock',
      model: this.brainChoice.deepseek ? (this.config.brain?.model || 'deepseek-chat') : null,
      turns: this.turns.length,
      indexed: this.turnIndex.size,
      tools: this.tools.list().map((t) => t.name),
      soulId: rt?.id || this.defaultSoul,
      defaultSoul: this.defaultSoul,
      souls: this.souls.list(),
      sessions: this.sessions.list(rt?.id || this.defaultSoul).length,
      session: this.currentTurn?.session || null,
      traits: rt?.traits || [],
      memory: rt ? rt.memory.health() : null,
      disposition: rt?.disposition ? rt.disposition.health() : null,
      people: rt ? Object.keys(rt.people.data.accounts || {}).length : 0,
      facts: rt ? rt.facts.rows().length : 0,
      records: rt ? rt.records.health() : null,
      vitals: (rt?.vitals || this.vitalsFor())?.health() || null,
      vitalsBySoul: Object.fromEntries(this.souls.list().map((s) => {
        const rt = this.runtimes.get(s.id);
        return [s.id, rt?.vitals ? { ...rt.vitals.health() } : null];
      })),
      gate: this.pipeline.gate.health(),
      metrics: { ...this.metrics, avgMs: this.metrics.turns ? Math.round(this.metrics.totalMs / this.metrics.turns) : 0 },
      adapters: this.adapters.map((a) => (typeof a.health === 'function' ? a.health() : { id: a.constructor?.name })),
      reflection: this.reflection.health(),
      reflex: this.reflex.health(),
      autolog: this.autolog.health(),
    };
  }
}
