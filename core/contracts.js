let seq = 0;
export const nextId = (p = 'id') => `${p}-${Date.now().toString(36)}-${(seq += 1)}`;

export const Intent = { SAY: 'say', REPLY: 'reply', TOOL: 'tool', SILENT: 'silent', REPORT: 'report' };
export const Organ = { SPEECH: 'speech', TOOL: 'tool', BODY: 'body' };
export const Expects = { REPLY: 'reply', RESULT: 'result', NONE: 'none' };
export const Sender = { OTHER: 'other', SELF: 'self', SYSTEM: 'system', TOOL: 'tool' };

/** 通道 → 人话标签。QQ群 / QQ私聊 / 网页终端 / 调试终端 / B站。names 可覆盖（如群名、昵称）。 */
const LABELS = [
  [/^group:(\d+)$/, (m) => `QQ群 ${m[1]}`],
  [/^private:(\d+)$/, (m) => `QQ私聊 ${m[1]}`],
  [/^terminal:debug$/, () => '调试终端'],
  [/^terminal:([\w-]+)$/, (m) => `网页终端 ${m[1]}`],
  [/^bili:([\w-]+)$/, (m) => `B站·${m[1]}`],
  [/^web:([\w-]+)$/, (m) => `网页 ${m[1]}`],
];

export function channelLabel(channel, names = {}) {
  const ch = String(channel || '');
  if (names[ch]) return names[ch];
  for (const [re, fn] of LABELS) {
    const m = ch.match(re);
    if (m) return fn(m);
  }
  return ch || '未知通道';
}

/** 一次「发生」：任何进入她感知的东西。media[] 统一放 payload.media。 */
export function occurrence({
  sender = Sender.OTHER, senderId = null, name = null, source = '', channel = '',
  content = '', medium = 'text', media = [], intent = Intent.SAY,
  replyTo = null, causedBy = null, ts = Date.now(), meta = {},
} = {}) {
  if (!channel) throw new Error('occurrence 需要 channel');
  const list = Array.isArray(media) ? media : [];
  const first = list.find((m) => m && m.type) || null;
  return {
    id: nextId('occ'),
    ts,
    provenance: {
      sender, senderId,
      name: name || sender,
      source, channel,
      channelLabel: channelLabel(channel),
    },
    payload: {
      medium: medium || first?.type || 'text',
      content: String(content ?? ''),
      media: list,
    },
    causality: { replyTo, causedBy },
    intent,
    meta,
  };
}

/** 把一条发生渲染成一行文字（供上下文/调试页共用，QQ / 终端 / B站同一套）。 */
export function renderOccurrence(occ) {
  const p = occ?.provenance || {};
  const label = p.channelLabel || channelLabel(p.channel);
  const who = p.name || p.sender || '?';
  const media = (occ?.payload?.media || [])
    .map((m) => `[${m.type || 'file'}${m.name ? ':' + m.name : ''}]`)
    .join(' ');
  const body = String(occ?.payload?.content ?? '');
  return `[${label}] ${who}${media ? ' ' + media : ''}：${body}`;
}

/** 一次「作用」：她对外做了什幺。 */
export function act({
  organ = Organ.SPEECH, target = '', payload = {}, media = [],
  expects = Expects.NONE, causedBy = null, meta = {},
} = {}) {
  if (!target) throw new Error('act 需要 target');
  return {
    id: nextId('act'),
    ts: Date.now(),
    organ, target,
    payload: { ...payload },
    media: Array.isArray(media) ? media : [],
    expects,
    causality: { causedBy },
    meta,
  };
}

export function toolResult({ ok = true, data = null, error = null, ms = 0 } = {}) {
  return { ok, data, error, ms };
}

/** 分条：先按空行，再按长句兜底；最多 maxParts 条。 */
export function splitForChat(text, { maxParts = 3, maxLen = 400 } = {}) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const parts = [];
  for (const block of raw.split(/\n\s*\n+/)) {
    const b = block.trim();
    if (!b) continue;
    if (b.length <= maxLen) { parts.push(b); continue; }
    let rest = b;
    while (rest.length > maxLen) {
      const cut = Math.max(rest.lastIndexOf('。', maxLen), rest.lastIndexOf('！', maxLen), rest.lastIndexOf('？', maxLen), rest.lastIndexOf('；', maxLen));
      if (cut <= 0) break;
      parts.push(rest.slice(0, cut + 1).trim());
      rest = rest.slice(cut + 1).trim();
    }
    if (rest) parts.push(rest);
  }
  return parts.filter(Boolean).slice(0, maxParts);
}
