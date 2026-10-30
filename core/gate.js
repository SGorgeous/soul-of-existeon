const DEFAULT_POLICIES = [
  { match: 'terminal:debug', identity: 'owner', caps: ['chat', 'tools', 'memory', 'admin'] },
  { match: 'terminal:*', identity: 'owner', caps: ['chat', 'tools', 'memory'] },
  { match: 'private:*', identity: 'owner', caps: ['chat', 'tools', 'memory'] },
  { match: 'group:*', identity: 'trusted', caps: ['chat', 'memory_read'] },
];

/** 策略表匹配：精确、前缀 `x:*`、或通配 `*`。 */
function matches(pattern, channel) {
  const p = String(pattern || '');
  const ch = String(channel || '');
  if (p === '*') return true;
  if (p.endsWith(':*')) return ch.startsWith(p.slice(0, -1));
  return p === ch;
}

function bypassSet(bypass, channel) {
  for (const [pattern, list] of Object.entries(bypass || {})) {
    if (!matches(pattern, channel)) continue;
    const arr = Array.isArray(list) ? list : [list];
    return new Set(arr.map(String));
  }
  return null;
}

/**
 * 门禁：身份与能力 + 通道白名单 + 频率 + 体力/精力/睡眠。
 * 所有豁免（含 terminal:debug）都来自配置，代码里不认具体通道名。
 */
export class Gate {
  constructor({ config = {}, vitals = null, logger = console } = {}) {
    this.cfg = {
      policies: DEFAULT_POLICIES,
      whitelist: ['terminal:*', 'private:*', 'group:*', 'bili:*'],
      bypass: { 'terminal:debug': ['all'] },
      ratePerMinute: 8,
      ratePerHour: 60,
      reactionMin: 0.15,
      ...config,
    };
    this.vitals = vitals;
    this.logger = logger;
    this.recent = new Map(); // channel -> [ts]
    this.stats = { checks: 0, denied: 0, last: null };
  }

  resolve(channel) {
    const hit = (this.cfg.policies || DEFAULT_POLICIES).find((p) => matches(p.match, channel));
    return hit || { identity: 'stranger', caps: ['chat'] };
  }

  can(channel, cap) {
    return this.resolve(channel).caps.includes(cap);
  }

  allowedByWhitelist(channel) {
    const list = this.cfg.whitelist || [];
    if (!list.length) return true;
    return list.some((p) => matches(p, channel));
  }

  bypassFor(channel) {
    return bypassSet(this.cfg.bypass, channel);
  }

  skipped(channel, check) {
    const by = this.bypassFor(channel);
    return !!by && (by.has('all') || by.has(check));
  }

  /** 滑动窗口：每分钟 / 每小时。被拒的请求不计数。 */
  rateCheck(channel, now = Date.now(), key = null) {
    const k = String(key || channel);
    const list = (this.recent.get(k) || []).filter((t) => now - t < 3600000);
    const lastMinute = list.filter((t) => now - t < 60000).length;
    if (lastMinute >= this.cfg.ratePerMinute) {
      this.recent.set(k, list);
      return { ok: false, reason: 'rate-per-minute', retryAfterMs: 60000 };
    }
    if (list.length >= this.cfg.ratePerHour) {
      this.recent.set(k, list);
      return { ok: false, reason: 'rate-per-hour', retryAfterMs: 3600000 };
    }
    this.recent.set(k, [...list, now]);
    return { ok: true };
  }

  async check(turn) {
    const channel = String(turn.channel || '');
    const policy = this.resolve(channel);
    this.stats.checks += 1;

    if (!this.skipped(channel, 'whitelist') && !this.allowedByWhitelist(channel)) {
      this.stats.denied += 1;
      this.stats.last = { channel, reason: 'channel-not-allowed', t: Date.now() };
      return { ok: false, reason: 'channel-not-allowed', identity: policy.identity, caps: policy.caps };
    }

    if (!this.skipped(channel, 'rate')) {
      const r = this.rateCheck(channel, Date.now(), channel + '|' + (turn?.soul || ''));
      if (!r.ok) {
        this.stats.denied += 1;
        this.stats.last = { channel, reason: r.reason, t: Date.now() };
        return { ok: false, reason: r.reason, retryAfterMs: r.retryAfterMs, identity: policy.identity, caps: policy.caps };
      }
    }

    // vitals 可以是实例，也可以是 (turn) => 实例 —— 多灵魂时每个灵魂一套体力
    const vt = typeof this.vitals === 'function' ? this.vitals(turn) : this.vitals;
    if (vt && !this.skipped(channel, 'vitals')) {
      const v = vt.check();
      if (!v.ok) {
        this.stats.denied += 1;
        this.stats.last = { channel, reason: v.reason, t: Date.now() };
        return { ok: false, reason: v.reason, identity: policy.identity, caps: policy.caps, vitals: v };
      }
      if (v.reaction != null && v.reaction < this.cfg.reactionMin) {
        this.stats.denied += 1;
        this.stats.last = { channel, reason: 'too-tired', t: Date.now() };
        return { ok: false, reason: 'too-tired', reaction: v.reaction, identity: policy.identity, caps: policy.caps, vitals: v };
      }
    }

    return { ok: true, identity: policy.identity, caps: policy.caps, bypass: [...(this.bypassFor(channel) || [])] };
  }

  health() {
    return { checks: this.stats.checks, denied: this.stats.denied, last: this.stats.last, channels: this.recent.size };
  }
}
