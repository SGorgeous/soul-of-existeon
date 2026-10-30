import fs from 'node:fs';
import path from 'node:path';
import { readJson } from '../core/read.js';

/**
 * 倾向（Disposition）：她不只按规则走，还有「喜欢 → 想靠近」「讨厌 → 想躲开」。
 *
 * 这一层只做三件事：
 *   1. 评估一句话戳到喜欢还是讨厌（appraise）
 *   2. 维护此刻的心情 / 焦虑 / 对某人的亲近（notice + tickSilence）
 *   3. 给提示词一段「此刻的我」（promptBlock），并让三思知道她现在什么脾气
 *
 * 状态落在 <soul>/disposition.json —— 每个灵魂各一份，互不影响。
 * 设计来源：existere v1 的 mind/disposition.js（那版是全局单例，这里是按灵魂隔离）。
 */

const DEFAULT_LIKES = ['泡水', '下雨天', '被摸头', '鱼', '水'];
const DEFAULT_DISLIKES = ['干燥', '静电', '被冷落', '被忽视', '被嫌烦', '没用的东西'];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** 把「喜欢：水、雨、冰。」里的每一项洗干净 */
function cleanWord(s) {
  return String(s || '')
    .replace(/^[\s：:、，,。；;（(「『“‘"']+/, '')
    .replace(/[\s，,、。；;！!？?）)」』”’"'].*$/, '')
    .replace(/^(和|跟|以及|还有)/, '')
    .trim();
}
const usable = (w) => w.length >= 1 && w.length <= 12 && !/[「」『』""''“”]/.test(w);

/**
 * 从角色卡里抠「喜欢 / 讨厌」清单。
 * 优先认结构化的那几行（`- 喜欢：水、雨、冰…` / `- 讨厌：干燥、静电…`），
 * 没有的话退回到散文里找（「喜欢泡水、喜欢下雨天，讨厌干燥和静电」）。
 */
export function parseFromRole(text) {
  const src = String(text || '');
  const likes = [];
  const dislikes = [];
  let explicit = false;

  for (const raw of src.split(/\r?\n/)) {
    const m = /^[\s\-*·]*(喜欢|讨厌|不喜欢|很怕|怕)\s*[：:]\s*(.+)$/.exec(raw.trim());
    if (!m) continue;
    explicit = true;
    const words = m[2].split(/[、，,]/).map(cleanWord).filter(usable);
    if (m[1] === '喜欢') likes.push(...words); else dislikes.push(...words);
  }

  if (!explicit) {
    for (const line of src.split(/[\n。；;！!？?]/)) {
      for (const piece of line.split(/[、，,]/)) {
        const like = /喜欢(.{1,10})/.exec(piece);
        if (like) { const w = cleanWord(like[1]); if (usable(w)) likes.push(w); }
        const hate = /(?:讨厌|不喜欢|很怕|怕)(.{1,10})/.exec(piece);
        if (hate) { const w = cleanWord(hate[1]); if (usable(w)) dislikes.push(w); }
      }
    }
  }

  return { likes: [...new Set(likes)].slice(0, 10), dislikes: [...new Set(dislikes)].slice(0, 10) };
}

export class Disposition {
  /**
   * @param {object} o
   * @param {string} o.soulDir        这个灵魂的目录（状态写这里）
   * @param {string} o.persona        角色卡正文（用来自动抽喜恶清单）
   * @param {string[]} o.likes        额外喜欢（配置里写的）
   * @param {string[]} o.dislikes     额外讨厌
   * @param {number} o.silenceMinutes 多久没来往算「被冷落」（默认 30 分钟）
   */
  constructor({ soulDir, persona = '', likes = [], dislikes = [], silenceMinutes = 30, stateFile = null } = {}) {
    this.dir = soulDir || path.join(process.cwd(), 'state', 'souls', 'vaporeon');
    this.file = stateFile || path.join(this.dir, 'disposition.json');
    this.silenceMinutes = silenceMinutes;
    const fromRole = parseFromRole(persona);
    this.prefs = {
      likes: [...new Set([...fromRole.likes, ...DEFAULT_LIKES, ...likes])].slice(0, 20),
      dislikes: [...new Set([...fromRole.dislikes, ...DEFAULT_DISLIKES, ...dislikes])].slice(0, 20),
    };
    this.state = {
      mood: '平静',
      anxiety: 0,
      affection: { owner: 0.7 },
      lastContactAt: Date.now(),
      moodUntil: 0,       // 这股情绪至少持续到什么时候（不然一句话就哄好/就忘了）
      updatedAt: Date.now(),
    };
    this.load();
  }

  load() {
    try {
      const saved = readJson(this.file);
      if (saved && typeof saved === 'object') {
        this.state = { ...this.state, ...saved };
        if (saved.likes?.length) this.prefs.likes = saved.likes;
        if (saved.dislikes?.length) this.prefs.dislikes = saved.dislikes;
      }
    } catch { /* 首次 */ }
  }

  save() {
    this.state.updatedAt = Date.now();
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const out = { ...this.state, likes: this.prefs.likes, dislikes: this.prefs.dislikes };
      fs.writeFileSync(this.file, JSON.stringify(out, null, 2));
    } catch { /* 记不下来不影响回复 */ }
  }

  /** 这句话戳到喜欢还是讨厌 */
  appraise(text) {
    const t = String(text || '');
    const hitLike = this.prefs.likes.filter((k) => k && t.includes(k));
    const hitDislike = this.prefs.dislikes.filter((k) => k && t.includes(k));
    const likeScore = Math.min(1, hitLike.length * 0.4);
    const dislikeScore = Math.min(1, hitDislike.length * 0.45);
    let stance = 'neutral';
    if (likeScore > dislikeScore && likeScore > 0) stance = 'approach';
    else if (dislikeScore > likeScore) stance = 'avoid';
    return { stance, likeScore, dislikeScore, hitLike, hitDislike };
  }

  /** 被喜欢的人长时间没来往 → 着急 / 害怕（每轮结算一次） */
  tickSilence(now = Date.now()) {
    const since = (now - Number(this.state.lastContactAt || now)) / 60000;
    if (since <= this.silenceMinutes) return { escalated: false, mood: this.state.mood, anxiety: this.state.anxiety };
    this.state.anxiety = clamp(this.state.anxiety + 2, 0, 10);
    this.state.mood = this.state.anxiety >= 7 ? '害怕' : (this.state.anxiety >= 4 ? '着急' : '不安');
    this.state.moodUntil = now + 8 * 60000;
    this.save();
    return { escalated: true, sinceMinutes: Math.round(since), mood: this.state.mood, anxiety: this.state.anxiety };
  }

  bumpAffection(person, delta) {
    const key = String(person || 'owner');
    const cur = this.state.affection[key] ?? (key === 'owner' ? 0.7 : 0.4);
    this.state.affection[key] = clamp(cur + delta, 0, 1);
  }

  /**
   * 一轮输入进来：先结算冷落，再看这句话，更新心情/焦虑/亲近。
   * @param {object} turn  { input:{text}, person }
   */
  notice(turn = {}) {
    const now = Date.now();
    const silence = this.tickSilence(now);
    const text = String(turn.input?.text || '');
    const person = String(turn.person || turn.meta?.person || 'owner');
    const a = this.appraise(text);
    if (a.stance === 'approach') {
      this.state.mood = '开心';
      this.state.moodUntil = now + 4 * 60000;
      this.state.anxiety = clamp(this.state.anxiety - 1, 0, 10);
      this.bumpAffection(person, 0.05);
    } else if (a.stance === 'avoid') {
      this.state.mood = '嫌弃';
      this.state.moodUntil = now + 6 * 60000;
      this.state.anxiety = clamp(this.state.anxiety + 2, 0, 10);
      this.bumpAffection(person, -0.1);
    } else {
      this.state.anxiety = clamp(this.state.anxiety - 0.5, 0, 10);
      // 冷落刚被这一句打断：保留着急/害怕，别一句话就哄好
      if (now >= Number(this.state.moodUntil || 0) && !silence.escalated) {
        this.state.mood = this.state.anxiety >= 7 ? '害怕' : (this.state.anxiety >= 4 ? '不安' : '平静');
        this.state.moodUntil = 0;
      }
    }
    this.state.lastContactAt = now;
    this.save();
    return { ...a, mood: this.state.mood, anxiety: this.state.anxiety, affection: this.state.affection[person] ?? null, silence };
  }

  /** 给提示词的一段「此刻的我」 */
  promptBlock() {
    const likes = this.prefs.likes.slice(0, 8).join('、');
    const dislikes = this.prefs.dislikes.slice(0, 8).join('、');
    const owner = this.state.affection?.owner ?? 0.7;
    return [
      '【此刻的我】',
      `脾气：${this.state.mood}；焦虑 ${this.state.anxiety}/10；对主人的亲近 ${owner.toFixed(2)}。`,
      `喜欢：${likes}——遇到会想靠近、多嘴、黏一点。`,
      `讨厌：${dislikes}——遇到会嫌弃、躲开、甚至不理。`,
      '遇到讨厌的：可以嫌弃、少说两句、甚至直接不理；别为了讨好委屈自己。',
      '被喜欢的人冷落太久会着急、害怕，甚至哭；不要假装没事。',
    ].join('\n');
  }

  /** 给三思看的那点脾气 */
  tone() {
    return { mood: this.state.mood, anxiety: this.state.anxiety };
  }

  health() {
    return {
      mood: this.state.mood,
      anxiety: this.state.anxiety,
      affection: { ...this.state.affection },
      silenceMinutes: this.silenceMinutes,
      sinceContactMin: Math.round((Date.now() - Number(this.state.lastContactAt || Date.now())) / 60000),
      likes: this.prefs.likes.slice(0, 6),
      dislikes: this.prefs.dislikes.slice(0, 6),
      file: path.relative(process.cwd(), this.file).split(path.sep).join('/'),
    };
  }
}
