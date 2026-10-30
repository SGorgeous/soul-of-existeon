import { splitForChat } from './contracts.js';

/** 组合阶段：分条、去空、兜底。媒体先留空数组，等接图片能力。 */
export class Composer {
  constructor({ maxParts = 3 } = {}) { this.maxParts = maxParts; }

  async compose(turn) {
    const raw = (turn.replies || []).join('\n\n');
    let replies = splitForChat(raw, { maxParts: this.maxParts });
    if (!replies.length) replies = ['（我这边没说出话，等我一下）'];
    return { replies, media: turn.media || [] };
  }
}
