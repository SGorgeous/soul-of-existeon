import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readJson } from '../core/read.js';

/**
 * 自动落记忆 / 日记（Autolog）
 *
 * 为什么要有它：记忆、笔记、日记原本只有「她主动调工具」才会写，所以平时什么都不会留下。
 * 这里在一轮结束后替她判断一次「这一轮值得记吗」，最多记一条：
 *
 *   承诺/约定  → 写一条记忆（salience 0.7）
 *   冷落整夜   → 写一条日记
 *   心情骤变   → 写一条日记（|心情档位差| ≥ diaryOnMoodJump）
 *   「第一次」 → 写一条笔记
 *
 * 防止刷屏：同类每天有上限（maxPerDay）、同文本 dedupeHours 小时内不重复写。
 * 计数与去重表按灵魂存在 `state/souls/<id>/autolog.json`。
 */

const DAY = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** 心情档位：越往下越难受；比较的是「档位差」，所以 平静→开心 和 开心→嫌弃 都算大跳 */
const MOOD_RANK = { 开心: 2, 平静: 0, 嫌弃: -2, 不安: -3, 着急: -4, 害怕: -5 };

const PROMISE_RE = /记住|答应|约好|说定了|别忘了|不许忘|以后都/;
const FIRST_RE = /第一次|初次|头一回|生平头一次/;

/** 从一句话里抠点关键词（二字词 + 三字头 + 英文词），够召回用就行 */
export function keywordsFrom(text, limit = 6) {
  const t = String(text || '');
  const out = [];
  for (const run of t.match(/[\u3400-\u9fff]{2,}/g) || []) {
    for (let i = 0; i + 2 <= run.length; i += 2) out.push(run.slice(i, i + 2));
    if (run.length >= 3) out.push(run.slice(0, 3));
  }
  for (const w of t.match(/[A-Za-z][A-Za-z0-9_-]{1,}/g) || []) out.push(w);
  return [...new Set(out)].slice(0, limit);
}

const short = (s, n = 120) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
};

export class AutoLog {
  constructor({ root = process.cwd(), config = {} } = {}) {
    this.root = root;
    this.cfg = {
      enabled: true,
      memoryOnPromise: true,
      memorySalience: 0.7,
      diaryOnMoodJump: 2,
      diaryOnSilenceMinutes: 180,
      noteOnFirst: true,
      maxPerDay: { memory: 5, diary: 3, note: 3 },
      dedupeHours: 24,
      ...config,
    };
  }

  fileFor(soulDir) { return path.join(soulDir, 'autolog.json'); }

  load(soulDir) {
    try {
      const j = readJson(this.fileFor(soulDir));
      if (j && typeof j === 'object') {
        return {
          day: String(j.day || ''),
          counts: j.counts && typeof j.counts === 'object' ? { ...j.counts } : {},
          seen: Array.isArray(j.seen) ? j.seen : [],
        };
      }
    } catch { /* 首次 */ }
    return { day: '', counts: {}, seen: [] };
  }

  save(soulDir, st) {
    try {
      fs.mkdirSync(soulDir, { recursive: true });
      fs.writeFileSync(this.fileFor(soulDir), JSON.stringify(st, null, 2));
    } catch { /* 记不下来不影响回复 */ }
  }

  /** 只看这一轮值不值得记，不落盘（方便单测） */
  decide(turn = {}) {
    if (!this.cfg.enabled) return null;
    if (turn.skipped) return null;                       // 门禁没放行的轮次不算「发生过」
    if (turn.state === 'failed') return null;
    const text = String(turn.input?.text || '');
    const who = turn.person === 'owner' ? '主人' : (turn.person || '有人');
    const reply = String((turn.replies || []).slice(-1)[0] || '');

    // 1) 承诺 / 约定 → 记忆
    if (this.cfg.memoryOnPromise && PROMISE_RE.test(text)) {
      const used = (turn.toolCalls || []).some((c) => c.name === 'memory_write');
      if (!used) {
        return {
          kind: 'memory',
          reason: 'promise',
          text: `${who}说的原话：${short(text)}`,
          keywords: keywordsFrom(text),
          salience: Number(this.cfg.memorySalience) || 0.7,
        };
      }
    }

    // 2) 冷落一整夜 → 日记
    const silence = turn.silence;
    if (silence?.escalated && Number(silence.sinceMinutes) >= Number(this.cfg.diaryOnSilenceMinutes)) {
      const hours = Math.round(Number(silence.sinceMinutes) / 60);
      return {
        kind: 'diary',
        reason: 'silence',
        title: '等了好久',
        text: `隔了 ${hours} 小时才等到${who}。\n\n他第一句是「${short(text, 60)}」。我先是有点急，想问一句「去哪了」，后来听见声音又松了口气，就没问。`,
      };
    }

    // 3) 心情骤变 → 日记
    const prev = turn.moodPrev;
    const now = turn.mood;
    const jumped = prev && now && MOOD_RANK[prev] != null && MOOD_RANK[now] != null
      && Math.abs(MOOD_RANK[now] - MOOD_RANK[prev]) >= Number(this.cfg.diaryOnMoodJump);
    // 只有「一头是负面情绪」才算值得写下来的骤变：开心↔平静 这种日常起伏不记
    const negative = (m) => MOOD_RANK[m] != null && MOOD_RANK[m] <= -2;
    if (jumped && (negative(now) || negative(prev))) {
      return {
        kind: 'diary',
        reason: 'mood-jump',
        title: now === '嫌弃' ? '有点不痛快' : (now === '不安' || now === '着急' ? '心里发慌' : '心里沉了一下'),
        text: `刚才还是${prev}的，说到「${short(text, 60)}」的时候，心里一下子${now}了。\n\n我回了他「${short(reply, 60)}」，其实还有半句没说出口。`,
      };
    }

    // 4) 「第一次」→ 笔记
    if (this.cfg.noteOnFirst && FIRST_RE.test(text)) {
      return {
        kind: 'note',
        reason: 'first-time',
        text: `第一次：${short(text)}`,
      };
    }

    return null;
  }

  /**
   * 真正写下去。runtime 是 SoulRuntime（要有 dir / memory / records）。
   * 返回 { ok, kind, reason } 或 { skipped } —— 一律不抛。
   */
  after(turn, runtime) {
    if (!runtime || !runtime.dir) return null;
    let decision = null;
    try { decision = this.decide(turn); } catch { return null; }
    if (!decision) return null;

    const st = this.load(runtime.dir);
    const today = DAY();
    if (st.day !== today) { st.day = today; st.counts = {}; }

    const now = Date.now();
    const keepMs = Number(this.cfg.dedupeHours) * 3600 * 1000;
    st.seen = st.seen.filter((s) => s && now - Number(s.ts || 0) < keepMs);

    const hash = crypto.createHash('sha1').update(`v1|${decision.text}`).digest('hex').slice(0, 12);
    if (st.seen.some((s) => s.h === hash)) return { ok: false, skipped: 'dup', kind: decision.kind };

    const max = Number(this.cfg.maxPerDay?.[decision.kind] ?? 3);
    if ((st.counts[decision.kind] || 0) >= max) return { ok: false, skipped: 'cap', kind: decision.kind };

    try {
      if (decision.kind === 'memory') {
        if (!runtime.memory?.write) return null;
        runtime.memory.write({
          text: decision.text,
          keywords: decision.keywords || [],
          salience: decision.salience ?? 0.7,
          source: 'auto',
        });
      } else if (decision.kind === 'diary') {
        if (!runtime.records?.diaryWrite) return null;
        runtime.records.diaryWrite(decision.text, { title: decision.title || '随手记', source: '自动' });
      } else if (decision.kind === 'note') {
        if (!runtime.records?.noteAdd) return null;
        runtime.records.noteAdd(decision.text, { tags: ['第一次'] });
      } else {
        return null;
      }
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }

    st.counts[decision.kind] = (st.counts[decision.kind] || 0) + 1;
    st.seen.push({ h: hash, ts: now, kind: decision.kind });
    this.save(runtime.dir, st);

    return {
      ok: true,
      kind: decision.kind,
      reason: decision.reason,
      text: short(decision.text, 80),
      today: st.counts[decision.kind],
    };
  }

  health() {
    return { enabled: !!this.cfg.enabled, maxPerDay: this.cfg.maxPerDay, dedupeHours: this.cfg.dedupeHours };
  }
}
