import { toolResult } from '../core/contracts.js';

const EMPTY_SCHEMA = { type: 'object', properties: {}, required: [], additionalProperties: false };

/**
 * 工具注册表：JSON Schema + 超时 + 只读/写入分类 + 预算。
 * 只认注册时给的 schema，不猜参数；超时一律返回 ok:false。
 */
export class ToolRegistry {
  constructor({ timeoutMs = 15000 } = {}) {
    this.tools = new Map();
    this.timeoutMs = timeoutMs;
    this.register({
      name: 'time_now',
      description: '现在几点（本机时间）',
      kind: 'read',
      schema: EMPTY_SCHEMA,
      fn: async () => ({ now: new Date().toISOString(), local: new Date().toLocaleString('zh-CN') }),
    });
    this.register({
      name: 'echo',
      description: '原样返回（调试用）',
      kind: 'read',
      schema: {
        type: 'object',
        properties: { text: { type: 'string', description: '要原样返回的文字' } },
        required: ['text'],
        additionalProperties: false,
      },
      fn: async ({ text } = {}) => ({ text: String(text || '') }),
    });
  }

  register({ name, description = '', schema = EMPTY_SCHEMA, kind = 'read', external = false, timeoutMs, fn }) {
    if (!name || typeof fn !== 'function') throw new Error('register 需要 name 和 fn');
    this.tools.set(name, {
      name,
      description,
      schema: schema && typeof schema === 'object' ? schema : EMPTY_SCHEMA,
      kind: kind === 'write' ? 'write' : 'read',
      external: !!external,   // true = 会把参数发到外网（这类工具不要拿真词去查）
      timeoutMs: Number(timeoutMs) || this.timeoutMs,
      fn,
    });
    return this;
  }

  /** 调试页 / GET /api/tools 用：带 schema 的可枚举清单。 */
  list() {
    return [...this.tools.values()].map(({ name, description, schema, kind, external, timeoutMs }) => ({
      name, description, kind, timeoutMs, schema, external: !!external,
    }));
  }

  /** 给大脑的 function calling 描述。 */
  schemas() {
    return [...this.tools.values()].map(({ name, description, schema }) => ({
      name, description, parameters: schema,
    }));
  }

  async invoke(name, args = {}) {
    const t = this.tools.get(name);
    if (!t) return toolResult({ ok: false, error: `未知工具：${name}` });
    const started = Date.now();
    try {
      const out = await Promise.race([
        t.fn(args),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`工具超时：${name}`)), t.timeoutMs)),
      ]);
      // 工具自己返回 {ok:false} 时不要当成功包一层
      if (out && typeof out === 'object' && out.ok === false) {
        return toolResult({ ok: false, error: String(out.error || '工具失败'), data: out.data ?? null, ms: Date.now() - started });
      }
      return toolResult({ ok: true, data: out, ms: Date.now() - started });
    } catch (e) {
      return toolResult({ ok: false, error: String(e?.message || e), ms: Date.now() - started });
    }
  }

  health() {
    return { count: this.tools.size, names: [...this.tools.keys()] };
  }
}

/** 无进展检测：同名同参重复调用视为原地打转。 */
export function isProgress(calls) {
  const seen = new Set();
  for (const c of calls) {
    const key = c.name + JSON.stringify(c.args || {});
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}
