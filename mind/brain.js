import { splitForChat } from '../core/contracts.js';

/** mock 大脑：规则式回复，方便先把流水线跑通（不联网）。 */
export class MockBrain {
  async think({ turn, step = 1, toolResults = [] } = {}) {
    const text = String(turn.input.text || '');
    if (step === 1 && /几点|时间/.test(text)) {
      return { thinking: '她想知道时间，调 time_now。', intents: [{ kind: 'tool', name: 'time_now', args: {} }] };
    }
    if (toolResults.length) {
      const last = toolResults.at(-1);
      return { thinking: `拿到工具结果：${last.name}`, intents: [{ kind: 'reply', text: `查到了：${JSON.stringify(last.result?.data || {})}水咿~` }] };
    }
    return { thinking: '简单回一句。', intents: [{ kind: 'reply', text: `${text ? '听到你说「' + text.slice(0, 20) + '」' : '在呢'}，水咿~` }] };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * DeepSeek 大脑（function calling）。
 * - 超时（默认 45s）+ 网络/5xx/429 自动重试一次
 * - 空回复兜底
 * - 只认 reasoner 传进来的工具 schema
 */
export class DeepseekBrain {
  constructor({ apiKey, model = 'deepseek-chat', base = 'https://api.deepseek.com/chat/completions', timeoutMs = 45000, retries = 1, logger = console } = {}) {
    this.apiKey = apiKey;
    this.model = model || 'deepseek-chat';
    this.base = base;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.logger = logger;
  }

  buildMessages(turn, toolResults = [], nudge = '') {
    const ctx = turn.context || {};

    const system = [
      ctx.persona || '你是水伊布，说话短。',
      ctx.growth || '',
      ctx.mood || '',
      ctx.senses || '',
      ctx.stickerHint || '',
      ctx.pendingThought ? '【刚才一个人时想到的】' + ctx.pendingThought + '（可以自然地提一句，不用硬说）' : '',
      ctx.memory?.length ? '记忆：\n' + ctx.memory.join('\n') : '',
      ctx.facts?.length ? '事实：\n' + ctx.facts.join('\n') : '',
      ctx.lessons?.length ? '上一轮的教训（别重犯）：\n' + ctx.lessons.join('\n') : '',
      '回复要短，1-3 句。需要查东西就调用工具，不要编。',
    ].filter(Boolean).join('\n\n');
    const history = (ctx.occurrences || []).join('\n');
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: history + '\n\n本轮：' + String(turn.input.text || '') },
    ];
    if (toolResults.length) {
      messages.push({ role: 'user', content: '工具结果：' + JSON.stringify(toolResults).slice(0, 2000) });
    }
    if (nudge) messages.push({ role: 'user', content: String(nudge) });
    return messages;
  }

  async think({ turn, step = 1, toolResults = [], tools = [], nudge = '', onDelta = null } = {}) {
    // 流式：只有前端显式要（SSE）时才走，普通请求还是原来的一次性调用
    if (turn?.stream && typeof onDelta === 'function') {
      try {
        return await this.thinkStream({ turn, step, toolResults, tools, onDelta });
      } catch (e) {
        // 流断了就退回非流式，别让一整轮对话失败
        if (this.debug) console.warn('[brain] 流式失败，回退普通调用：' + e.message);
      }
    }
    const payload = {
      model: this.model,
      messages: this.buildMessages(turn, toolResults, nudge),
      max_tokens: 500,
      temperature: 0.8,
      stream: false,
    };
    if (tools.length) {
      payload.tools = tools.map((t) => ({ type: 'function', function: t }));
      payload.tool_choice = 'auto';
    }

    let lastErr = null;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      if (attempt > 0) await sleep(400 * attempt);
      try {
        const res = await fetch(this.base, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) {
          const retriable = res.status === 429 || res.status >= 500;
          lastErr = new Error(j.error?.message || `HTTP ${res.status}`);
          if (retriable && attempt < this.retries) continue;
          throw lastErr;
        }
        const msg = j.choices?.[0]?.message || {};
        const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
        if (calls.length) {
          const names = calls.map((c) => c?.function?.name).filter(Boolean).join('、');
          // 调工具时模型常会同时写一段正文（旁白/台词）。那不是「思考」，是这一轮要说的话：
          // 单独带回去，由 reasoner 排在正式回复前面。以前塞进 thinking，界面当思考展示，看着像被吞了。
          return {
            thinking: `决定调用工具：${names}`,
            say: String(msg.content || '').trim().slice(0, 400),
            intents: calls
              .filter((c) => c?.function?.name)
              .map((c) => ({ kind: 'tool', name: c.function.name, args: safeJson(c.function.arguments) })),
          };
        }
        const text = String(msg.content || '').trim();
        // deepseek-chat 不返回思考文本。以前把「回复本身」当 thinking 塞进去，
        // 界面上就成了「思考 = 我刚说的那句话」，看着像复读。这里只在真有 reasoning 时记。
        const reasoning = String(msg.reasoning_content || '').trim();
        return {
          thinking: reasoning ? reasoning.slice(0, 800) : '',
          intents: [{ kind: 'reply', text: text || '嗯。' }],
        };
      } catch (e) {
        lastErr = e;
        if (attempt >= this.retries) break;
      }
    }
    throw lastErr || new Error('DeepSeek 调用失败');
  }
  /** 流式版 think：边收边把文字吐给 onDelta，最后返回和非流式一样的结构 */
  async thinkStream({ turn, toolResults = [], tools = [], onDelta }) {
    const payload = {
      model: this.model,
      messages: this.buildMessages(turn, toolResults, nudge),
      max_tokens: 500,
      temperature: 0.8,
      stream: true,
    };
    if (tools.length) {
      payload.tools = tools.map((t) => ({ type: 'function', function: t }));
      payload.tool_choice = 'auto';
    }
    const res = await fetch(this.base, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok || !res.body) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error?.message || ('HTTP ' + res.status));
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let content = '';
    let reasoning = '';
    const calls = new Map();   // index → { id, name, args }

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const frames = buf.split('\n\n');
      buf = frames.pop() || '';
      for (const frame of frames) {
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const raw = line.slice(5).trim();
          if (!raw || raw === '[DONE]') continue;
          let j = null;
          try { j = JSON.parse(raw); } catch { continue; }
          const delta = j.choices?.[0]?.delta || {};
          if (delta.content) {
            content += delta.content;
            try { onDelta(delta.content); } catch { /* 前端断开也继续收完 */ }
          }
          if (delta.reasoning_content) reasoning += delta.reasoning_content;
          for (const tc of delta.tool_calls || []) {
            const at = Number.isInteger(tc.index) ? tc.index : 0;
            const cur = calls.get(at) || { id: '', name: '', args: '' };
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name += tc.function.name;
            if (tc.function?.arguments) cur.args += tc.function.arguments;
            calls.set(at, cur);
          }
        }
      }
    }

    if (calls.size) {
      const list = [...calls.values()].filter((c) => c.name);
      const names = list.map((c) => c.name).join('、');
      return {
        thinking: `决定调用工具：${names}`,
        say: String(content || '').trim().slice(0, 400),
        intents: list.map((c) => ({ kind: 'tool', name: c.name, args: safeJson(c.args) })),
      };
    }
    const text = String(content || reasoning).trim();
    return {
      thinking: reasoning ? reasoning.slice(0, 800) : '',
      intents: [{ kind: 'reply', text: text || '嗯。' }],
    };
  }
}

function safeJson(s) {
  try { return JSON.parse(s || '{}'); } catch { return {}; }
}

export { splitForChat };
