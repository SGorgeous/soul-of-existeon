import fs from 'node:fs';
import path from 'node:path';
import { readUtf8 } from '../core/read.js';

/**
 * 反思：一轮结束后产结构化教训，下一轮注入 prompt。
 * 只记「下次能改的」：出错、工具失败、被停止策略收尾、三思拦下的句子、整轮没话说。
 * 门禁直接拦下的轮次不算教训（那不是她的问题）。
 */
export class Reflection {
  constructor({ root, limit = 200, keepRecent = 50 } = {}) {
    this.root = root || process.cwd();
    this.limit = limit;
    this.keepRecent = keepRecent;
    this.file = path.join(this.root, 'state', 'reflections.jsonl');
    this.recent = [];
    this.load();
  }

  load() {
    try {
      const rows = readUtf8(this.file).trim().split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      this.recent = rows.slice(-this.keepRecent);
    } catch { /* 还没有 */ }
  }

  extract(turn) {
    const list = [];
    if (!turn) return list;
    if (turn.events?.some((e) => e.skipped)) return list;
    if (turn.error) list.push({ kind: 'error', text: '上一轮出错：' + turn.error });
    for (const c of turn.toolCalls || []) {
      if (!c.result?.ok) list.push({ kind: 'tool-failed', text: `工具 ${c.name} 失败：${c.result?.error || '未知原因'}` });
    }
    if (turn.stopped && turn.stopped !== 'error') {
      list.push({ kind: 'stopped', text: `上一轮因 ${turn.stopped} 收尾，别重复同样的调用` });
    }
    for (const n of turn.policyNotes || []) list.push({ kind: 'policy', text: '上一句被拦下：' + n });
    if (!(turn.replies || []).length && !(turn.policyNotes || []).length && !turn.stopped) {
      list.push({ kind: 'empty', text: '上一轮没说出话，检查工具结果或换个说法' });
    }
    return list;
  }

  after(turn) {
    const lessons = this.extract(turn);
    if (!lessons.length) return [];
    const rows = lessons.map((l) => ({ t: Date.now(), channel: turn.channel, soul: turn.soul || null, ...l }));
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    } catch { /* 忽略 */ }
    this.recent.push(...rows);
    if (this.recent.length > this.keepRecent) this.recent = this.recent.slice(-this.keepRecent);
    return rows;
  }

  lessonsFor(channel, limit = 3, soul = null) {
    return this.recent
      .filter((r) => r.channel === channel && (!soul || !r.soul || r.soul === soul))
      .slice(-limit)
      .map((r) => r.text);
  }

  health() { return { file: this.file, recent: this.recent.length }; }
}
