/** 影子模式：同一输入喂给两套内核，只有 primary 的回复会发出去。 */
export class Shadow {
  constructor({ primary, shadow, logger = console } = {}) {
    this.primary = primary;
    this.shadow = shadow;
    this.logger = logger;
  }

  async runTurn(input) {
    const main = await this.primary.runTurn(input);
    const t0 = Date.now();
    let other = null;
    try { other = await this.shadow.runTurn({ ...input, meta: { ...(input.meta || {}), shadow: true } }); } catch (e) { this.logger.warn('[shadow] ' + (e?.message || e)); }
    const row = {
      at: Date.now(),
      channel: input.channel,
      input: input.text,
      primary: { replies: main.replies, ms: main.durationMs, brain: main.brain, state: main.state },
      shadow: other ? { replies: other.replies, ms: other.durationMs, brain: other.brain, state: other.state } : null,
      deltaMs: other ? Date.now() - t0 : null,
    };
    try {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const dir = path.join(process.cwd(), 'state');
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, 'shadow.jsonl'), JSON.stringify(row) + '\n');
    } catch { /* ignore */ }
    return main;
  }
}
