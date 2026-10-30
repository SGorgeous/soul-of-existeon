/**
 * Token 用量与人民币估算
 *
 * 优先用 turn.usage（模型返回的真实 usage）；老记录没有就按文本估算。
 * 价格是配置项（config.usage），默认按 DeepSeek 常见价：输入 ¥2/百万、输出 ¥8/百万。
 */
import fs from 'node:fs';
import path from 'node:path';

const DAY = 86400_000;

function estimateTokens(text) {
  const s = String(text || '');
  if (!s) return 0;
  const cjk = (s.match(/[\u3400-\u9fff]/g) || []).length;
  const rest = s.length - cjk;
  return Math.ceil(cjk + rest / 4);
}

export class UsageMeter {
  constructor({ root, config = {} } = {}) {
    this.root = root;
    this.cfg = {
      inputPerM: 2,
      outputPerM: 8,
      currency: 'CNY',
      monthlyBudget: 30,
      ...config,
    };
  }

  turnsPath() { return path.join(this.root, 'state', 'turns.jsonl'); }

  rows(soulId = null) {
    try {
      return fs.readFileSync(this.turnsPath(), 'utf8').trim().split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter((t) => t && (!soulId || t.soul === soulId));
    } catch { return []; }
  }

  /** 单轮 token：真实 usage 优先，否则估算（context.used + 输入 + 输出 + 工具） */
  tokensOf(turn) {
    const u = turn.usage || {};
    if (Number(u.prompt_tokens) || Number(u.completion_tokens) || Number(u.total_tokens)) {
      return {
        input: Number(u.prompt_tokens) || 0,
        output: Number(u.completion_tokens) || 0,
        real: true,
      };
    }
    const contextTokens = Number(turn.context?.used) || 0;
    const inputText = String(turn.input?.text || '');
    const toolText = JSON.stringify(turn.toolCalls || []);
    const replyText = (turn.replies || []).join('');
    return {
      input: contextTokens + estimateTokens(inputText) + estimateTokens(toolText),
      output: estimateTokens(replyText),
      real: false,
    };
  }

  summary(soulId = null, now = Date.now()) {
    const month = new Date(now).toISOString().slice(0, 7);
    const rows = this.rows(soulId).filter((t) => {
      const d = new Date(t.at || 0);
      return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 7) === month;
    });
    let input = 0; let output = 0; let realTurns = 0; let tools = 0;
    for (const t of rows) {
      const x = this.tokensOf(t);
      input += x.input;
      output += x.output;
      if (x.real) realTurns += 1;
      tools += (t.toolCalls || []).length;
    }
    const cost = input / 1e6 * Number(this.cfg.inputPerM) + output / 1e6 * Number(this.cfg.outputPerM);
    const budget = Number(this.cfg.monthlyBudget) || 0;
    return {
      month,
      turns: rows.length,
      inputTokens: input,
      outputTokens: output,
      totalTokens: input + output,
      cost: Math.round(cost * 10000) / 10000,
      currency: this.cfg.currency,
      budget,
      remaining: Math.round(Math.max(0, budget - cost) * 10000) / 10000,
      price: { inputPerM: Number(this.cfg.inputPerM), outputPerM: Number(this.cfg.outputPerM) },
      realTurns,
      estimated: rows.length - realTurns,
      tools,
    };
  }
}
