/**
 * 「这句话是在跟我说吗？」
 *
 * 群里所有人说话都会进内核，但不是每句都冲她来的。以前只有「潜水概率」这一层，
 * 结果是别人聊天她也要耗一次模型。这里先做一道硬判断：
 *
 *   私聊 / 终端 / B站私信      → 永远算在跟她说
 *   群聊                        → 只有 @她、引用她、话里带她的名字 —— 才算
 *   其它通道                    → 默认算（以后加了新通道别默认静音）
 *
 * 返回 { addressed, reason }；reason 会写进 turn 事件，方便调试「她为什么没理」。
 */

const DIRECT = /^(private|terminal|bili|web):/i;
const GROUP = /^(group|room):/i;

const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();

export function isAddressed(turn = {}, { names = [], aliases = [] } = {}) {
  const channel = String(turn.channel || '');
  if (DIRECT.test(channel)) return { addressed: true, reason: 'direct-channel' };

  if (GROUP.test(channel)) {
    const meta = turn.meta || {};
    if (meta.atMe === true || meta.mentionsMe === true) return { addressed: true, reason: 'at-me' };
    if (meta.replyToMe === true || meta.quotedMe === true) return { addressed: true, reason: 'reply-to-me' };

    const text = norm(turn.input?.text);
    const want = [...names, ...aliases].map(norm).filter((n) => n.length >= 2);
    const hit = want.find((n) => text.includes(n));
    if (hit) return { addressed: true, reason: 'name', name: hit };

    // 群友私下问「@某人 你觉得呢」这种不算
    return { addressed: false, reason: 'not-addressed' };
  }

  return { addressed: true, reason: 'default' };
}

export class Addressing {
  constructor({ config = {} } = {}) {
    this.cfg = { aliases: [], groupOnly: true, ...config };
  }

  /** names 由调用方按当前灵魂给（名字 + id） */
  check(turn, names = []) {
    if (!this.cfg.groupOnly) return { addressed: true, reason: 'disabled' };
    return isAddressed(turn, { names, aliases: this.cfg.aliases || [] });
  }
}
