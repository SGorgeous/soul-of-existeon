const SECRET_RE = /(sk-[0-9a-f]{16,}|BEGIN [A-Z ]*PRIVATE KEY|密码\s*[:：]|身份证|银行卡号|1[3-9]\d{9})/i;

/**
 * 行为层的「三思」：话出口前的最后一道审查。
 * - 凭据/隐私/身份证/手机号 → 不发
 * - 超长 → 不发
 * - 伤人话按礼貌值决定（低礼貌时允许直一点）
 * debug 等豁免通道由 Gate 的 bypass 传进来，policy 自己不认识具体通道名。
 */
export class Policy {
  constructor({ config = {}, logger = console } = {}) {
    this.cfg = {
      enabled: true,
      maxChars: 500,
      secrets: true,
      // 脏词只认「独立成词」：不然「打滚 / 翻滚 / 滚动」都会被误判成骂人
      insults: '(?:^|[\\s，。！？!?~…、；;])滚(?:$|[\\s，。！？!?~…、；;])|滚开|滚蛋|滚远点|滚出去|闭嘴|烦死|讨厌你',
      politeness: 0.7,
      groupReplyProbability: 1,
      ...config,
    };
    this.logger = logger;
  }

  bypassed(bypass = []) {
    return bypass.includes('all') || bypass.includes('policy');
  }

  review(text, { bypass = [], tone = null } = {}) {
    const notes = [];
    let approved = true;
    const t = String(text || '');
    if (!this.cfg.enabled || this.bypassed(bypass)) return { approved, notes };
    // 三思会读她当时的脾气：嫌弃/害怕/高焦虑时允许直接一点，开心时允许话长一点
    const mood = String(tone?.mood || '');
    const anxiety = Number(tone?.anxiety ?? 0);
    const soft = mood === '嫌弃' || mood === '害怕' || anxiety >= 7;
    const happy = mood === '开心';
    const politeness = Number(this.cfg.politeness ?? 0.7) + (soft ? -0.4 : 0) + (happy ? 0.1 : 0);
    const maxChars = Number(this.cfg.maxChars ?? 500) + (happy ? 120 : 0);

    if (this.cfg.secrets && SECRET_RE.test(t)) {
      approved = false;
      notes.push('疑似凭据/隐私，不能发');
    }
    if (t.length > maxChars) {
      approved = false;
      notes.push(`话太长（${t.length} > ${maxChars}）`);
    }
    let insult = null;
    try { insult = this.cfg.insults ? new RegExp(this.cfg.insults) : null; } catch { insult = null; }
    if (insult && insult.test(t) && politeness > 0.5) {
      approved = false;
      notes.push('这种话出口会伤到人');
    } else if (insult && insult.test(t)) {
      notes.push('心情不好，这句直话放她说了');
    }
    // 高焦虑时如果她一句示弱都没有，提一句（不拦，只提醒）
    if (anxiety >= 7 && !/累|怕|想|陪|抱|别走|难受|不安/.test(t)) {
      notes.push('这会儿很不安，可以示弱求陪，不必硬撑');
    }
    return { approved, notes };
  }

  /** 群聊里非 @ 的消息按概率潜水；嫌弃的时候更容易不想理（debug 豁免依然来自 bypass）。 */
  shouldStayQuiet(turn) {
    const ch = String(turn?.channel || '');
    if (!ch.startsWith('group:')) return false;
    if (turn?.meta?.atMe === true) return false;
    if (this.bypassed(turn?.bypass || [])) return false;
    // 被戳到讨厌的东西：这一轮更可能装没看见
    if (turn?.stance === 'avoid' && Math.random() < 0.5) return true;
    const p = Number(this.cfg.groupReplyProbability ?? 1);
    if (p >= 1) return false;
    if (p <= 0) return true;
    return Math.random() > p;
  }

  /** 组装时要保留的回复（三思过滤后的）。放行的那些如果带提醒（比如"心情不好"）也一并留下 */
  filter(replies, { bypass = [], tone = null } = {}) {
    const kept = [];
    const notes = [];
    for (const r of replies || []) {
      const v = this.review(r, { bypass, tone });
      if (v.notes.length) notes.push(...v.notes);
      if (v.approved) kept.push(r);
    }
    return { kept, notes };
  }
}

export { SECRET_RE };
