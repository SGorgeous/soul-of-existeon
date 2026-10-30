/** 漫游的小工具（纯函数，便于测试） */
import { contextKey } from '../../learning/habits.js';

export const clamp01 = (n) => Math.max(0, Math.min(1, Number(n) || 0));

/** 稳定随机：同一个种子 + 同一个 key，结果一样（便于复现问题） */
export function seeded(seed, key) {
  let h = 2166136261 ^ (Number(seed) | 0);
  const s = String(key || '');
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 13;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 16;
  return ((h >>> 0) % 100000) / 100000;
}

export function habitCtx(now, mood, drive, last) {
  const h = new Date(now).getHours();
  const part = h < 6 ? '深夜' : h < 12 ? '上午' : h < 14 ? '中午' : h < 18 ? '下午' : h < 22 ? '晚上' : '深夜';
  return contextKey({ part, mood: /开心/.test(mood) ? '开心' : /不安|害怕|着急/.test(mood) ? '不安' : /嫌弃|烦/.test(mood) ? '嫌弃' : '平静', drive, last });
}

export const MOOD_RANK = { 开心: 2, 平静: 0, 嫌弃: -2, 不安: -3, 着急: -4, 害怕: -5 };
