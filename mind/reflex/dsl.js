/**
 * 条件反射 DSL：「当……就……」。
 *
 * 这是潜意识层：只看字面、时间和状态，**不调模型、不进思考**，命中就直接做。
 * 规则写在 state/reflexes.txt（每个灵魂还可以有自己的 state/souls/<id>/reflexes.txt）。
 *
 * 一行一条，语法：
 *
 *   当 <条件> [且 <条件>]… 就 <动作> [并 <动作>]… [冷却 15秒] [优先级 20]
 *
 * 条件：
 *   文本含「摸摸头/摸头」          任意一个出现就算命中（/ 分隔）
 *   文本匹配 /^(在吗|在不在)[？?]*$/   正则（可带 i 等 flags：/…/i）
 *   通道 terminal:*                通道通配（* 结尾表示前缀）
 *   谁 owner                       谁在说话（turn.person）
 *   心情 开心/嫌弃                  当前心情
 *   焦虑 ≥7                        焦虑（≥ > ≤ < =）
 *   时间 23:00-02:00               时间窗（可跨午夜）
 *   冷落 ≥60                       多久没来往（分钟）
 *   精力 <30                       体力层精力
 *
 * 动作：
 *   回「一句话」                    直出（不思考）
 *   回「A」或「B」或「C」           多个说法里随机挑（不连着重同一句）
 *   不说                           不思考也不回
 *   改写「……」（配合 文本匹配 $1）   改写输入后再进正常流程
 *   发表情 happy                    顺手发个表情包
 *
 * 例：
 *   当 文本匹配 /^(在吗|在不在|在么)[？?~～…!！。]*$/ 就 回「在的水咿~」 冷却 15秒
 *   当 文本含「摸摸头/摸头/揉揉」 就 回「（眯眼）水咿~」并发表情 happy 冷却 1分
 *   当 心情 嫌弃 且 文本含「啦/哦」 就 回「嗯。」
 *   当 时间 23:00-02:00 且 文本含「晚安」 就 回「晚安水咿~ 早点睡。」
 */

const COMPARE = { '≥': '>=', '>=': '>=', '≤': '<=', '<=': '<=', '>': '>', '<': '<', '=': '==' };

/** 去掉行尾注释（不碰引号 / 正则里的 #） */
function stripComment(line) {
  let inQuote = false;
  let inRe = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === '「') inQuote = true;
    else if (c === '」') inQuote = false;
    else if (c === '/' && !inQuote) {
      if (!inRe) inRe = true;
      else if (line[i - 1] !== '\\') inRe = false;
    } else if (c === '#' && !inQuote && !inRe) return line.slice(0, i);
  }
  return line;
}

function quoted(s) {
  return [...String(s || '').matchAll(/「([^」]*)」/g)].map((m) => m[1]);
}

function parseDuration(s) {
  const m = String(s || '').trim().match(/^(\d+(?:\.\d+)?)\s*(秒钟|秒|分|分钟|小时|时)?/);
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = m[2] || '秒';
  if (unit.startsWith('小时') || unit === '时') return n * 3600000;
  if (unit.startsWith('分')) return n * 60000;
  return n * 1000;
}

/** 解析「比较」条件：焦虑 ≥7 */
function parseCompare(rest) {
  const m = String(rest || '').trim().match(/^(≥|<=|≤|>=|>|<|=)\s*(-?\d+(?:\.\d+)?)/);
  if (!m) return null;
  return { op: COMPARE[m[1]], value: Number(m[2]) };
}

function parseCond(raw) {
  const s = String(raw || '').trim();
  if (!s) return { error: '空条件' };

  const patterns = [
    ['文本含', /^文本含\s*(.+)$/],
    ['文本匹配', /^文本匹配\s*(.+)$/],
    ['通道', /^通道\s*(.+)$/],
    ['谁', /^谁\s*(.+)$/],
    ['心情', /^心情\s*(.+)$/],
    ['时间', /^时间\s*(.+)$/],
    ['焦虑', /^焦虑\s*(.+)$/],
    ['冷落', /^冷落\s*(.+)$/],
    ['精力', /^精力\s*(.+)$/],
  ];
  for (const [kind, re] of patterns) {
    const m = s.match(re);
    if (!m) continue;
    const rest = m[1].trim();
    if (kind === '文本含') {
      const words = [...quoted(rest)];
      const list = words.length ? words.flatMap((w) => w.split(/[\/、,，]/)) : rest.split(/[\/、,，]/);
      const keywords = list.map((x) => x.trim()).filter(Boolean);
      if (!keywords.length) return { error: '文本含 里没有词' };
      return { kind: 'text', mode: 'contains', keywords };
    }
    if (kind === '文本匹配') {
      const m2 = rest.match(/^\/(.*)\/([a-z]*)$/);
      if (!m2) return { error: '文本匹配 要写成 /正则/ （可选 /i）' };
      try { new RegExp(m2[1], m2[2]); } catch (e) { return { error: '正则不合法：' + e.message }; }
      return { kind: 'text', mode: 'regex', regex: m2[1], flags: m2[2] || '' };
    }
    if (kind === '通道') {
      const list = rest.split(/[\/、,，]/).map((x) => x.trim()).filter(Boolean);
      return { kind: 'channel', list };
    }
    if (kind === '谁') {
      return { kind: 'person', list: rest.split(/[\/、,，]/).map((x) => x.trim()).filter(Boolean) };
    }
    if (kind === '心情') {
      return { kind: 'mood', list: quoted(rest).length ? quoted(rest).join('/').split(/[\/、,，]/) : rest.split(/[\/、,，]/), list2: null };
    }
    if (kind === '时间') {
      const m3 = rest.match(/(\d{1,2}):(\d{2})\s*[-~到]\s*(\d{1,2}):(\d{2})/);
      if (!m3) return { error: '时间要写成 23:00-02:00' };
      const toMin = (h, mi) => Number(h) * 60 + Number(mi);
      return { kind: 'time', from: toMin(m3[1], m3[2]), to: toMin(m3[3], m3[4]) };
    }
    // 焦虑 / 冷落 / 精力 都是比较
    const cmp = parseCompare(rest);
    if (!cmp) return { error: kind + ' 后面要写比较，例如 ≥7' };
    return { kind: kind === '焦虑' ? 'anxiety' : kind === '冷落' ? 'silence' : 'energy', op: cmp.op, value: cmp.value };
  }
  return { error: '不认识的写法：' + s.split(/\s/)[0] };
}

function parseAction(raw) {
  const s = String(raw || '').trim();
  if (!s) return { error: '空动作' };
  if (s === '不说') return { kind: 'silent' };

  const mReply = s.match(/^回\s*(.+)$/);
  if (mReply) {
    const parts = quoted(mReply[1]);
    if (!parts.length) return { error: '回 后面要用「」包住要说的话' };
    return { kind: 'reply', variants: parts };
  }
  const mRewrite = s.match(/^改写\s*(.+)$/);
  if (mRewrite) {
    const parts = quoted(mRewrite[1]);
    if (!parts.length) return { error: '改写 后面要用「」包住' };
    return { kind: 'rewrite', text: parts[0] };
  }
  const mSticker = s.match(/^发表情\s*([\w-]+)?/);
  if (mSticker) {
    if (!mSticker[1]) return { error: '发表情 后面要写情绪，例如 happy' };
    return { kind: 'sticker', emotion: mSticker[1] };
  }
  return { error: '不认识的动作：' + s.split(/\s/)[0] };
}

/** 解析一行；返回 rule 或 { error } */
export function parseLine(line, lineNo = 0) {
  const raw = stripComment(line).trim();
  if (!raw || raw.startsWith('#')) return null;
  if (!raw.startsWith('当')) return { error: `第 ${lineNo} 行：要以「当」开头` };

  // 找「就」：避开引号和正则
  let cut = -1;
  let inQuote = false;
  let inRe = false;
  for (let i = 1; i < raw.length; i += 1) {
    const c = raw[i];
    if (c === '「') inQuote = true;
    else if (c === '」') inQuote = false;
    else if (c === '/' && !inQuote) { if (!inRe) inRe = true; else if (raw[i - 1] !== '\\') inRe = false; }
    else if (!inQuote && !inRe && raw.startsWith('就', i)) { cut = i; break; }
  }
  if (cut < 0) return { error: `第 ${lineNo} 行：缺少「就」` };

  const whenPart = raw.slice(1, cut).trim();
  let thenPart = raw.slice(cut + 1).trim();

  // 末尾修饰：冷却 / 优先级
  let cooldownMs = null;
  let priority = 0;
  const mCool = thenPart.match(/冷却\s*([\d.]+\s*(?:秒钟|秒|分钟|分|小时|时)?)/);
  if (mCool) { cooldownMs = parseDuration(mCool[1]); thenPart = thenPart.replace(mCool[0], '').trim(); }
  const mPrio = thenPart.match(/优先级\s*(-?\d+)/);
  if (mPrio) { priority = Number(mPrio[1]); thenPart = thenPart.replace(mPrio[0], '').trim(); }

  const conds = [];
  for (const piece of whenPart.split(/\s*且\s*/)) {
    const c = parseCond(piece);
    if (c.error) return { error: `第 ${lineNo} 行：${c.error}` };
    conds.push(c);
  }
  if (!conds.length) return { error: `第 ${lineNo} 行：没有条件` };

  const actions = [];
  for (const piece of thenPart.split(/\s*并\s*/)) {
    const a = parseAction(piece);
    if (a.error) return { error: `第 ${lineNo} 行：${a.error}` };
    actions.push(a);
  }
  if (!actions.length) return { error: `第 ${lineNo} 行：没有动作` };

  const firstText = conds.find((c) => c.kind === 'text');
  const name = (firstText && (firstText.keywords?.[0] || firstText.regex)) || `第${lineNo}行`;
  return {
    rule: {
      name: String(name).slice(0, 24),
      source: 'dsl',
      line: lineNo,
      when: conds,
      actions,
      cooldownMs,
      priority,
    },
  };
}

/** 解析整个文件；返回 {rules, errors} */
export function parseReflexText(text) {
  const rules = [];
  const errors = [];
  String(text || '').split(/\r?\n/).forEach((line, i) => {
    const r = parseLine(line, i + 1);
    if (!r) return;
    if (r.error) { errors.push(r.error); return; }
    rules.push(r.rule);
  });
  return { rules, errors };
}

/* ───────── 匹配 ───────── */

function channelMatches(pattern, channel) {
  const p = String(pattern || '');
  const ch = String(channel || '');
  if (p === '*') return true;
  if (p.endsWith(':*')) return ch.startsWith(p.slice(0, -1));
  return p === ch;
}

function timeInWindow(now, from, to) {
  const d = new Date(now);
  const m = d.getHours() * 60 + d.getMinutes();
  if (from === to) return true;
  return from < to ? (m >= from && m < to) : (m >= from || m < to);
}

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

/** 单个条件是否成立 */
export function condHolds(cond, ctx) {
  const c = cond || {};
  if (c.kind === 'text') {
    const text = String(ctx.text || '');
    if (c.mode === 'contains') return c.keywords.some((k) => text.includes(k));
    try { return new RegExp(c.regex, c.flags).test(text); } catch { return false; }
  }
  if (c.kind === 'channel') return c.list.some((p) => channelMatches(p, ctx.channel));
  if (c.kind === 'person') {
    const who = String(ctx.person || '');
    return c.list.some((x) => x === who || x === 'any');
  }
  if (c.kind === 'mood') return c.list.includes(String(ctx.mood || ''));
  if (c.kind === 'time') return timeInWindow(ctx.now || Date.now(), c.from, c.to);
  const table = { anxiety: () => num(ctx.anxiety), silence: () => num(ctx.silenceMin), energy: () => num(ctx.energy, 100) };
  const value = (table[c.kind] || (() => null))();
  if (value === null) return false;
  switch (c.op) {
    case '>=': return value >= c.value;
    case '<=': return value <= c.value;
    case '>': return value > c.value;
    case '<': return value < c.value;
    case '==': return value === c.value;
    default: return false;
  }
}

/** 规则是否命中（所有条件都要成立） */
export function ruleMatches(rule, ctx) {
  return (rule.when || []).every((c) => condHolds(c, ctx));
}
