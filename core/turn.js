import { nextId, channelLabel } from './contracts.js';

/**
 * 一轮对话 = 一个 Turn。
 * 所有阶段读它、写它；结束后整条记录可被调试页/测试直接消费。
 */
export const TurnState = {
  RECEIVED: 'received',
  GATED: 'gated',
  CONTEXTED: 'contexted',
  REASONING: 'reasoning',
  COMPOSED: 'composed',
  DELIVERED: 'delivered',
  DONE: 'done',
  FAILED: 'failed',
};

export class Turn {
  constructor({ channel, text = '', media = [], meta = {}, source = '', soul = null, session = null } = {}) {
    this.id = nextId('turn');
    this.startedAt = Date.now();
    this.at = this.startedAt;
    this.durationMs = null;
    this.channel = channel;
    this.channelLabel = channelLabel(channel);
    this.source = source;
    this.soul = soul;         // 哪个 soul 在处理这一轮（决定人格/记忆/事实/人）
    this.session = session;   // 会话 id（同一 soul 下切换「聊到哪」）
    this.input = { text, media: Array.isArray(media) ? media : [] };
    this.meta = meta;
    this.state = TurnState.RECEIVED;
    this.identity = null;
    this.context = null;      // { occurrences, memory, facts, persona, used, budget, dropped }
    this.thoughts = [];       // 每轮思考
    this.toolCalls = [];      // { name, args, result, ms }
    this.replies = [];
    this.media = [];
    this.stickers = [];   // 这一轮她发的表情包 [{ emotion, url }]
    this.stream = false;   // 是否流式（SSE）跑这一轮
    this.onDelta = null;   // (text) => void，模型吐字时的回调
    this.onEvent = null;   // (evt) => void，每个阶段事件都回调（SSE 用）
    this.events = [];         // { t, stage, ...data }
    this.stopped = null;      // 停止策略原因：max-steps / tool-budget / no-progress / time / error
    this.delivered = null;    // 是否真的发出去了（潜水/三思拦下时为 false）
    this.policyNotes = [];    // 三思审查说明
    this.reflexReply = null;  // 条件反射直出的回复
    this.continuation = 0;    // 续做了几轮（0 = 没续）
    this.error = null;
    this.brain = null;
    this.person = null;
    this.delivered = false;
    this.skipped = null;      // 门禁没放行的原因（low-focus / asleep / rate-…），界面靠它解释「她为什么没说话」
    this.mood = null;         // 这一轮她什么脾气（倾向层给的）
    this.moodPrev = null;     // 这一轮之前是什么脾气（自动落日记要比较）
    this.anxiety = null;
    this.silence = null;      // { escalated, sinceMinutes } —— 这一轮是被冷落多久之后来的
    this.stance = null;       // approach / avoid / neutral
    this.tone = null;         // 给三思看的 { mood, anxiety }
  }

  event(stage, data = {}) {
    const ev = { t: Date.now(), stage, ...data };
    this.events.push(ev);
    // SSE：每个阶段事件都往外推一份（推断了不影响这一轮）
    if (this.onEvent) { try { this.onEvent(ev); } catch { /* ignore */ } }
    return ev;
  }

  set(state, data = {}) {
    this.state = state;
    if (state === TurnState.DONE || state === TurnState.FAILED) {
      this.durationMs = Date.now() - this.startedAt;
      data = { ...data, durationMs: this.durationMs };
    }
    if (stageAllowed(state)) this.event(state, data);
  }

  toJSON() {
    return {
      id: this.id, at: this.at, startedAt: this.startedAt, durationMs: this.durationMs,
      soul: this.soul, session: this.session,
      channel: this.channel, channelLabel: this.channelLabel, source: this.source,
      state: this.state, identity: this.identity, input: this.input,
      context: this.context ? {
        person: this.context.person || null,
        used: this.context.used ?? null,
        budget: this.context.budget ?? null,
        dropped: this.context.dropped || null,
      } : null,
      brain: this.brain, person: this.person, delivered: this.delivered,
      sessionTitle: this.sessionTitle || null,
      thoughts: this.thoughts, toolCalls: this.toolCalls,
      replies: this.replies, media: this.media, stickers: this.stickers, stopped: this.stopped,
      skipped: this.skipped, policyNotes: this.policyNotes,
      mood: this.mood, moodPrev: this.moodPrev, anxiety: this.anxiety, stance: this.stance, silence: this.silence,
      continuation: this.continuation,
      events: this.events, error: this.error,
    };
  }
}

function stageAllowed(state) {
  return [
    TurnState.GATED, TurnState.CONTEXTED, TurnState.REASONING,
    TurnState.COMPOSED, TurnState.DELIVERED, TurnState.DONE, TurnState.FAILED,
  ].includes(state);
}
