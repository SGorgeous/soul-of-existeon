import { isProgress } from '../tools/index.js';

/**
 * 思考循环（ReAct 简化版）：
 *   think → (可选 tool) → observe → 直到「可以直接回答」或触发停止策略。
 *
 * 停止策略（四道闸，命中即写 stopped）：
 *   1. 步数 maxSteps        → 'max-steps'
 *   2. 工具预算 toolBudget  → 'tool-budget'
 *   3. 无进展（同名同参）   → 'no-progress'
 *   4. 时间预算 timeBudgetMs → 'time'
 *   另外：大脑抛错 → 'error'
 */
export class Reasoner {
  constructor({ brain, tools, logger = console, maxSteps = 4, toolBudget = 3, timeBudgetMs = 60000 } = {}) {
    this.brain = brain;
    this.tools = tools;
    this.logger = logger;
    this.maxSteps = maxSteps;
    this.toolBudget = toolBudget;
    this.timeBudgetMs = timeBudgetMs;
  }

  async run(turn) {
    const started = Date.now();
    const thoughts = [];
    const toolCalls = [];
    let budget = this.toolBudget;
    let replies = [];
    let stopped = null;
    const preSays = [];   // 调工具那几步里模型顺手写的正文（旁白/台词），要算进回复里

    for (let step = 1; step <= this.maxSteps; step += 1) {
      if (Date.now() - started > this.timeBudgetMs) {
        stopped = 'time';
        thoughts.push({ step, note: '时间预算用完，直接收尾' });
        break;
      }

      let out;
      try {
        out = await this.brain.think({
          turn,
          step,
          toolResults: toolCalls.map((c) => ({ name: c.name, result: c.result })),
          tools: this.tools.schemas ? this.tools.schemas() : [],
          onDelta: turn.onDelta || null,
        });
      } catch (e) {
        stopped = 'error';
        thoughts.push({ step, note: '大脑出错：' + String(e?.message || e) });
        break;
      }

      thoughts.push({ step, thinking: out.thinking || '', intents: out.intents?.length || 0 });
      if (out.say) preSays.push(String(out.say).trim());

      const wantsTool = (out.intents || []).find((i) => i.kind === 'tool');
      if (wantsTool && wantsTool.name) {
        if (budget <= 0) {
          stopped = 'tool-budget';
          thoughts.push({ step, note: `工具预算用完，还想调 ${wantsTool.name}，停止` });
          break;
        }
        const same = (c) => c.name === wantsTool.name && JSON.stringify(c.args || {}) === JSON.stringify(wantsTool.args || {});
        const repeats = toolCalls.filter(same).length;
        // 只有「看一眼」这类感官工具允许同一调用两次（看两眼很正常）；其余重复就算空转
        const glanceable = ['look', 'listen'].includes(wantsTool.name);
        const noProgress = !isProgress([...toolCalls, { name: wantsTool.name, args: wantsTool.args }])
          && !(glanceable && repeats < 2);
        if (noProgress) {
          stopped = 'no-progress';
          thoughts.push({ step, note: `工具 ${wantsTool.name} 重复调用，判定无进展，停止` });
          break;
        }
        const r = await this.tools.invoke(wantsTool.name, wantsTool.args || {});
        toolCalls.push({ name: wantsTool.name, args: wantsTool.args || {}, result: r, ms: r.ms });
        budget -= 1;
        continue;
      }

      replies = (out.intents || [])
        .filter((i) => i.kind === 'reply' && String(i.text || '').trim())
        .map((i) => String(i.text).trim());
      break;
    }

    // 循环跑满 maxSteps 仍在调工具 → 记为步数用尽
    if (!stopped && !replies.length) stopped = 'max-steps';

    // 工具已经真的执行过了（比如 walk_to + look），只是循环被停策略掐断：
    // 给一次「按已有结果收尾」的机会，不许再调工具 —— 否则会掉进那句莫名其妙的失败话术。
    if (!replies.length && toolCalls.length && stopped !== 'error') {
      try {
        const tail = await this.brain.think({
          turn,
          step: this.maxSteps + 1,
          toolResults: toolCalls.map((c) => ({ name: c.name, result: c.result })),
          tools: [],
          nudge: '工具已经执行完了。现在直接用上面的结果回答（1-3 句，用你自己的口吻），不要再调用工具。',
          onDelta: null,
        });
        const tailReplies = (tail.intents || [])
          .filter((i) => i.kind === 'reply' && String(i.text || '').trim())
          .map((i) => String(i.text).trim());
        if (tailReplies.length) replies = tailReplies;
        else if (String(tail.say || '').trim()) replies = [String(tail.say).trim()];
        thoughts.push({ step: this.maxSteps + 1, note: '收尾：按工具结果回答' });
      } catch (e) {
        thoughts.push({ step: this.maxSteps + 1, note: '收尾失败：' + String(e?.message || e) });
      }
    }

    if (!replies.length) {
      const usedSearch = toolCalls.some((c) => /search|recall|read/.test(c.name));
      replies = [stopped === 'error' || !toolCalls.length
        ? '我这轮没组织好，等我换个说法再试一次水咿~'
        : usedSearch
          ? '我查了，但没整理出能用的结果，换个说法/关键词我再试一次水咿~'
          : '我去看了，不过没看出什么特别的。'];
    }

    return { thoughts, toolCalls, replies, preSays, stopped, ms: Date.now() - started };
  }
}
