import fs from 'node:fs';
import path from 'node:path';

/**
 * 头像与表情包（按灵魂一套）。
 *
 * - 头像：`state/souls/<id>/avatar.png` 优先，其次 `assets/avatars/<id>.png`，最后 `_default.png`
 * - 表情：`assets/stickers/<id>/<emotion>.png`（来源是 PMD 迷宫素材里的表情头像，17 种情绪）
 *
 * 情绪名直接用文件名（happy / sad / angry …），模型挑一个就能发；
 * 中文标签只用于给模型看的提示词，不参与存储。
 */

export const EMOTION_LABEL = {
  happy: '开心',
  joyous: '欢喜',
  inspired: '有灵感',
  determined: '认真',
  normal: '平常',
  sigh: '叹气',
  worried: '担心',
  stunned: '愣住',
  surprised: '惊讶',
  dizzy: '晕',
  pain: '疼',
  sad: '难过',
  crying: '哭',
  'teary-eyed': '含泪',
  angry: '生气',
  shouting: '炸毛',
  special0: '害羞',
  special1: '得意',
  special2: '别扭',
  special3: '困',
};

/** 心情 → 自动表情（她没主动发、但情绪明显时兜底用） */
export const EMOTION_FOR_MOOD = {
  开心: 'joyous',
  嫌弃: 'sigh',
  不安: 'worried',
  着急: 'teary-eyed',
  害怕: 'crying',
  平静: null,
};

/** 情绪 → 适合在什么心情下发（给提示词用，别写死在代码逻辑里） */
export const EMOTION_HINT = '开心/欢喜→happy 或 joyous；难过/含泪→sad 或 teary-eyed；生气/炸毛→angry；担心→worried；' +
  '愣住/惊讶→stunned 或 surprised；叹气→sigh；认真→determined；想撒娇→special0；得意→special1；困→special3';

export class Stickers {
  constructor({ root = process.cwd(), dir = 'assets/stickers', avatarDir = 'assets/avatars' } = {}) {
    this.root = root;
    this.dir = path.isAbsolute(dir) ? dir : path.join(root, dir);
    this.avatarDir = path.isAbsolute(avatarDir) ? avatarDir : path.join(root, avatarDir);
    this.cache = new Map();
  }

  soulStickerDir(soulId) { return path.join(this.dir, String(soulId || 'vaporeon')); }

  /** 这个灵魂有哪些表情（文件名，去重、排序） */
  list(soulId) {
    const key = String(soulId || 'vaporeon');
    if (this.cache.has(key)) return this.cache.get(key);
    let out = [];
    try {
      out = fs.readdirSync(this.soulStickerDir(key))
        .filter((f) => f.toLowerCase().endsWith('.png'))
        .map((f) => f.replace(/\.png$/i, '').toLowerCase())
        .sort();
    } catch { out = []; }
    // 自己的表情 + 默认那套取并集：自己传的新表情不会把默认表情“顶掉”
    try {
      const fallback = fs.readdirSync(this.soulStickerDir('vaporeon'))
        .filter((f) => f.toLowerCase().endsWith('.png'))
        .map((f) => f.replace(/\.png$/i, '').toLowerCase());
      out = [...new Set([...out, ...fallback])].sort();
    } catch { /* 连默认都没有 */ }
    this.cache.set(key, out);
    return out;
  }

  has(soulId, emotion) { return this.list(soulId).includes(String(emotion || '').toLowerCase()); }

  /** 表情文件绝对路径；没有就返回 null（不会越出目录） */
  pathOf(soulId, emotion) {
    const e = String(emotion || '').toLowerCase();
    if (!/^[a-z0-9-]+$/.test(e)) return null;
    const own = path.join(this.soulStickerDir(soulId), e + '.png');
    if (fs.existsSync(own)) return own;
    const fallback = path.join(this.soulStickerDir('vaporeon'), e + '.png');
    return fs.existsSync(fallback) ? fallback : null;
  }

  /** 头像绝对路径（永远不会 404：最后有 _default.png） */
  avatarPath(soulId) {
    const id = String(soulId || 'vaporeon');
    const own = path.join(this.root, 'state', 'souls', id, 'avatar.png');
    if (fs.existsSync(own)) return own;
    const byId = path.join(this.avatarDir, id + '.png');
    if (fs.existsSync(byId)) return byId;
    const def = path.join(this.avatarDir, '_default.png');
    if (fs.existsSync(def)) return def;
    return null;
  }

  /** 保存头像（PNG 字节；调用方已转成 PNG） */
  saveAvatar(soulId, buf) {
    const dir = path.join(this.root, 'state', 'souls', String(soulId));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'avatar.png'), buf);
    return { ok: true, avatar: 'state/souls/' + soulId + '/avatar.png' };
  }

  /** 保存/替换一个表情（emotion 只允许小写字母数字和 -） */
  saveSticker(soulId, emotion, buf) {
    const e = String(emotion || '').toLowerCase();
    if (!/^[a-z0-9-]{1,24}$/.test(e)) return { ok: false, error: '表情名只能用小写字母、数字、短横线（1–24 位）' };
    const dir = this.soulStickerDir(soulId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, e + '.png'), buf);
    this.cache.delete(String(soulId));
    this.cache.delete('vaporeon');
    return { ok: true, emotion: e };
  }

  removeSticker(soulId, emotion) {
    const e = String(emotion || '').toLowerCase();
    if (!/^[a-z0-9-]{1,24}$/.test(e)) return { ok: false, error: '表情名不合法' };
    const file = path.join(this.soulStickerDir(soulId), e + '.png');
    try {
      if (!fs.existsSync(file)) return { ok: false, error: '没有这个表情' };
      fs.unlinkSync(file);
      this.cache.delete(String(soulId));
      return { ok: true };
    } catch (e2) { return { ok: false, error: String(e2?.message || e2) }; }
  }

  /** 给提示词的一段说明（只列这个灵魂真有的表情） */
  promptLine(soulId) {
    const list = this.list(soulId);
    if (!list.length) return '';
    const named = list.map((e) => (EMOTION_LABEL[e] ? `${e}(${EMOTION_LABEL[e]})` : e)).join('、');
    return `【表情包】你有 ${list.length} 个表情，想表达情绪时调 sticker_react(emotion)：${named}。\n` +
      `挑法：${EMOTION_HINT}。别每句都发，情绪明显时才发一个。`;
  }

  health(soulId = 'vaporeon') {
    return { dir: path.relative(this.root, this.dir).split(path.sep).join('/'), emotions: this.list(soulId) };
  }
}
