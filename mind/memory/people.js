import fs from 'node:fs';
import path from 'node:path';
import { occurrence, renderOccurrence, Sender } from '../../core/contracts.js';
import { readJson, readUtf8 } from '../../core/read.js';

/**
 * 人档案：账号 → 人 的映射，以及每人一份 jsonl 历史。
 * 跨渠道合并靠 people.json 的 accounts（例如 QQ 私聊和网页终端都映射到 owner）。
 */
export class People {
  constructor({ root, maxLines = 200, dir } = {}) {
    this.root = root || process.cwd();
    this.maxLines = maxLines;
    this.dir = dir || path.join(this.root, 'state', 'people');
    this.metaFile = path.join(this.dir, 'people.json');
    this.data = { accounts: {}, names: {} };
    this.loadMeta();
  }

  /** 读 people.json（账号映射 + 显示名）。注意：别叫 load —— 下面还有按人读历史行的 load(person)。 */
  loadMeta() {
    try {
      const j = readJson(this.metaFile);
      if (j) this.data = { accounts: j.accounts || {}, names: j.names || {} };
    } catch { /* 还没建档 */ }
  }

  save() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.metaFile, JSON.stringify(this.data, null, 2));
    } catch { /* 记不下来不影响对话 */ }
  }

  resolve(platform, account) {
    return this.data.accounts[`${platform}:${account}`] || null;
  }

  resolveOrCreate(platform, account, fallback = 'owner') {
    const key = `${platform}:${account}`;
    if (this.data.accounts[key]) return this.data.accounts[key];
    this.data.accounts[key] = fallback;
    this.save();
    return fallback;
  }

  name(person) { return this.data.names[person] || (person === 'owner' ? '主人' : person); }

  /** 通道 → 人：显式 meta.personId > people.json > 群/主人兜底。 */
  personOf(channel, meta = {}) {
    if (meta?.personId) return String(meta.personId);
    const ch = String(channel || '');
    if (this.data.accounts[ch]) return this.data.accounts[ch];
    const id = ch.includes(':') ? ch.slice(ch.indexOf(':') + 1) : ch;
    if (ch.startsWith('group:')) return 'group:' + id;
    if (ch.startsWith('bili:')) return 'bili:' + id;
    return 'owner';
  }

  file(person) {
    const safe = String(person || 'owner').replace(/[^\w:-]/g, '_');
    return path.join(this.dir, safe + '.jsonl');
  }

  load(person, limit = 30) {
    try {
      const rows = readUtf8(this.file(person)).trim().split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      return rows.slice(-limit);
    } catch { return []; }
  }

  /** 写入一轮：她说的话（仅已投递）+ 对方的输入。门禁拦下的轮次不写。 */
  recordTurn(turn, selfName = null) {
    if (!turn) return null;
    if (turn.events?.some((e) => e.skipped)) return null;
    const person = this.personOf(turn.channel, turn.meta);
    const list = [];
    const owner = turn.identity === 'owner' || person === 'owner';
    if (!turn.meta?.continuation) {
      list.push(occurrence({
        sender: owner ? 'owner' : 'other',
        name: this.name(person),
        source: turn.source || 'web',
        channel: turn.channel,
        content: String(turn.input?.text || ''),
        media: turn.input?.media || [],
        ts: turn.at,
      }));
    }
    if (turn.delivered !== false) {
      for (const text of turn.replies || []) {
        list.push(occurrence({
          sender: Sender.SELF, name: (selfName || turn.soulName || '我'), source: 'self',
          channel: turn.channel, content: text,
          ts: turn.at + (turn.durationMs || 0),
        }));
      }
    }
    const file = this.file(person);
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.appendFileSync(file, list.map((o) => JSON.stringify(o)).join('\n') + '\n');
      this.compact(person);
    } catch { /* 忽略 */ }
    return person;
  }

  /** 超长就截断成「摘要行 + 最近 maxLines 条」；语义摘要留给后续接模型。 */
  compact(person, keep = this.maxLines) {
    const file = this.file(person);
    let rows;
    try {
      rows = readUtf8(file).trim().split('\n').filter(Boolean);
    } catch { return null; }
    if (rows.length <= keep * 1.5) return { trimmed: 0 };
    const drop = rows.length - keep;
    const summary = {
      id: 'sum-' + Date.now().toString(36),
      ts: Date.now(),
      summary: true,
      provenance: { sender: 'system', name: '摘要', source: 'people', channel: '', channelLabel: '' },
      payload: { medium: 'text', content: `（更早的 ${drop} 条对话已省略，只保留最近 ${keep} 条）`, media: [] },
      causality: { replyTo: null, causedBy: null },
      intent: 'report',
      meta: { dropped: drop },
    };
    const next = [JSON.stringify(summary), ...rows.slice(-keep)];
    fs.writeFileSync(file, next.join('\n') + '\n');
    return { trimmed: drop };
  }

  /** 给 Context 用的一行人话。 */
  historyLines(person, limit = 20) {
    return this.load(person, limit).map((o) => (o.summary ? String(o.payload?.content || '') : renderOccurrence(o)));
  }
}

export default People;
