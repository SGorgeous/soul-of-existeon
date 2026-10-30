import { splitForChat } from './contracts.js';

/** 她已经用表情包表达了情绪时，删掉短括号里的动作/神态（只删短括号，保留事实性括号） */
function stripStageDirections(text) {
  return String(text || '')
    .replace(/<sticker_react[^>]*>?/gi, '')
    .replace(/（[^）]{1,24}）/g, '')
    .replace(/\([^)]{1,24}\)/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** 组合阶段：分条、去空、兜底。媒体先留空数组，等接图片能力。 */
export class Composer {
  constructor({ maxParts = 3 } = {}) { this.maxParts = maxParts; }

  async compose(turn) {
    const raw = (turn.replies || []).join('\n\n');
    let replies = splitForChat(raw, { maxParts: this.maxParts });
    // 有表情包时，动作交给表情，不再用括号写
    if ((turn.stickers || []).length) replies = replies.map(stripStageDirections).filter(Boolean);
    if (!replies.length) replies = ['（我这边没说出话，等我一下）'];
    if (!replies.length) replies = ['（我这边没说出话，等我一下）'];
    return { replies, media: turn.media || [] };
  }
}
