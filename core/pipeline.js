import { TurnState } from './turn.js';
import { Organ, Expects, act } from './contracts.js';
import { Policy } from './policy.js';

/**
 * 流水线：一轮 Turn 依次走 gate → context → reason → compose → review → deliver → post。
 * 每阶段只做一件事，可单独测；阶段失败有兜底，不让整轮消失。
 * 失败/被门禁拦下也走 post，保证 turns.jsonl 生命周期完整。
 */
export class Pipeline {
  constructor({ gate, context, reasoner, composer, policy, reflex, deliver, post, disposition = null, addressing = null, logger = console } = {}) {
    this.gate = gate;
    this.context = context;
    this.reasoner = reasoner;
    this.composer = composer;
    this.policy = policy || new Policy();
    this.reflex = reflex || null;
    this.deliver = deliver;
    this.post = post;
    this.disposition = disposition;
    this.addressing = addressing;
    this.logger = logger;
  }

  async run(turn) {
    try {
      await this._run(turn);
    } catch (e) {
      turn.error = String(e?.message || e);
      turn.set(TurnState.FAILED, { error: turn.error });
    }
    try {
      await this.post?.after(turn);
    } catch { /* 记不下来不影响回复 */ }
    return turn;
  }

  async _run(turn) {
    const gate = await this.gate.check(turn);
    turn.identity = gate.identity;
    turn.bypass = gate.bypass || [];
    if (!gate.ok) {
      turn.skipped = gate.reason || 'gated';
      turn.set(TurnState.DONE, { skipped: gate.reason, retryAfterMs: gate.retryAfterMs || null });
      if (gate.reason === 'rate-per-minute') turn.notice = '说太快了，让她缓一分钟再问。';
      return;
    }
    turn.set(TurnState.GATED, { identity: gate.identity, caps: gate.caps });

    // 这句话是在跟她说吗？群里别人聊天就别耗模型了（私聊/终端永远算在跟她说）
    if (this.addressing) {
      const a = this.addressing.check(turn);
      if (a && a.addressed === false) {
        turn.skipped = 'not-addressed';
        turn.event('not-addressed', { reason: a.reason });
        turn.set(TurnState.DONE, { skipped: 'not-addressed' });
        return;
      }
      if (a?.reason) turn.event('addressing', { addressed: true, reason: a.reason, name: a.name || null });
    }

    // 倾向：先结算「被冷落多久」，再看这句话戳到喜欢还是讨厌 —— 心情要在拼上下文之前定下来
    if (this.disposition) {
      const d = this.disposition.observe(turn);
      if (d) {
        turn.moodPrev = d.prevMood || null;
        turn.mood = d.mood;
        turn.anxiety = d.anxiety;
        turn.stance = d.stance;
        turn.silence = d.silence || null;
        turn.tone = { mood: d.mood, anxiety: d.anxiety };
        turn.event('disposition', {
          stance: d.stance, mood: d.mood, anxiety: d.anxiety, prevMood: d.prevMood || null,
          like: d.hitLike, dislike: d.hitDislike, silence: d.silence?.escalated || false,
        });
      }
    }

// 条件反射（潜意识）：只看字面/时间/状态，快速匹配，命中就直接做，不进思考。
    const hit = this.reflex?.check(turn, {
      text: turn.input?.text,
      channel: turn.channel,
      mood: turn.mood,
      anxiety: turn.anxiety,
      silenceMin: turn.silence?.sinceMinutes,
      energy: turn.vitals?.energy,
      person: turn.person || turn.meta?.person,
    });
    if (hit) {
      turn.event('reflex', { rule: hit.rule, action: hit.action, ms: Number(hit.ms || 0).toFixed(3) });
      if (hit.action === 'silent') {
        turn.replies = [];
        turn.delivered = false;
        turn.set(TurnState.DONE, { reflex: hit.rule, silent: true });
        return;
      }
      if (hit.action === 'rewrite' && hit.rewrite) {
        if (hit.regex) {
          try { turn.input.text = String(turn.input.text).replace(new RegExp(hit.regex), hit.rewrite); } catch { /* 规则写坏就不改 */ }
        } else {
          turn.input.text = String(hit.rewrite);
        }
      }
      if (hit.action === 'reply' && hit.reply) turn.reflexReply = String(hit.reply);
      if (hit.sticker) { turn.stickers = turn.stickers || []; turn.stickers.push(hit.sticker); }
    }

    // 潜意识直出：条件反射命中就不拼上下文、不思考（省一整轮 context + 模型）
    const fastReflex = !!turn.reflexReply;
    if (!fastReflex) {
      turn.context = await this.context.build(turn);
      turn.set(TurnState.CONTEXTED, {
        occurrences: turn.context.occurrences?.length || 0,
        memoryHits: turn.context.memoryHits || 0,
        lessons: turn.context.lessons?.length || 0,
        used: turn.context.used,
        budget: turn.context.budget,
        dropped: turn.context.dropped,
      });
    }

    turn.set(TurnState.REASONING);
    if (fastReflex) {
      turn.thoughts = [{ step: 0, thinking: '条件反射直出（没思考）' }];
      turn.toolCalls = [];
      turn.replies = [turn.reflexReply];
      turn.stopped = null;
      turn.context = turn.context || { used: 0, budget: 0, dropped: {}, occurrences: [], memoryHits: 0, lessons: [] };
      turn.set(TurnState.REASONING, { reflex: true, fast: true, replies: 1 });
    } else {
      const out = await this.reasoner.run(turn);
      turn.thoughts = out.thoughts || [];
      turn.toolCalls = out.toolCalls || [];
      // 调工具时模型顺带写的台词，排在正式回复前面（以前只能躺在「思考」里）
      turn.replies = [...(out.preSays || []), ...(out.replies || [])];
      turn.stopped = out.stopped || null;
      turn.set(TurnState.REASONING, { steps: turn.thoughts.length, tools: turn.toolCalls.length, stopped: turn.stopped });
    }

    const composed = await this.composer.compose(turn);
    const reviewed = this.policy.filter(composed.replies, { bypass: turn.bypass, tone: turn.tone });
    turn.replies = reviewed.kept;
    turn.policyNotes = reviewed.notes;
    turn.media = composed.media || [];
    turn.event('reviewed', { kept: reviewed.kept.length, dropped: composed.replies.length - reviewed.kept.length, notes: reviewed.notes });
    turn.set(TurnState.COMPOSED, { replies: turn.replies.length, media: turn.media.length });

    const quiet = this.policy.shouldStayQuiet(turn);
    turn.delivered = !quiet && turn.replies.length > 0;
    if (quiet) turn.event('stayed-quiet', { channel: turn.channel });
    if (turn.delivered) {
      for (const text of turn.replies) {
        await this.deliver.deliver(turn, act({ organ: Organ.SPEECH, target: turn.channel, payload: { text }, media: turn.media, expects: Expects.REPLY }));
      }
    }
    turn.set(TurnState.DELIVERED, { replies: turn.delivered ? turn.replies.length : 0, quiet });
    turn.set(TurnState.DONE);
    return turn;
  }
}
