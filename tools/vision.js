import fs from 'node:fs';
import path from 'node:path';
import { toolResult } from '../core/contracts.js';

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

export function visionConfig(config = {}) {
  return {
    url: process.env.EXISTEON_VISION_URL || config.url || '',
    key: process.env.EXISTEON_VISION_KEY || config.key || '',
    model: process.env.EXISTEON_VISION_MODEL || config.model || 'gpt-4o-mini',
    timeoutMs: Number(config.timeoutMs || 30000),
  };
}

function localToDataUrl(root, target) {
  const name = path.basename(String(target || ''));
  if (!/^[\w.-]+$/.test(name)) return null;
  const file = path.join(root, 'state', 'media', name);
  try {
    const buf = fs.readFileSync(file);
    const mime = MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch { return null; }
}

/** 图片参数 → 视觉模型能吃的 URL（data: 或 http）。默认取本轮/最近一张附件。 */
export function resolveImage(args = {}, { root = process.cwd(), lastMedia = [] } = {}) {
  if (args.dataUrl) return { ok: true, url: String(args.dataUrl) };
  let target = args.file || args.url || '';
  if (!target) {
    const m = (lastMedia || []).find((x) => x && (x.type === 'image' || /\.(png|jpe?g|webp|gif)$/i.test(x.url || x.file || '')));
    if (m) target = m.url || m.file || '';
  }
  if (!target) return { ok: false, error: '没有图片：给 url / file / dataUrl，或先发一张图' };
  const t = String(target);
  if (t.startsWith('data:')) return { ok: true, url: t };
  if (/^https?:/i.test(t)) return { ok: true, url: t };
  const local = localToDataUrl(root, t);
  if (!local) return { ok: false, error: `读不到本地图片：${t}` };
  return { ok: true, url: local };
}

/**
 * 看图：把图片交给 OpenAI 兼容的视觉端点，返回一句话描述。
 * 不配置就明确失败，不猜内容。
 */
export async function seeImage(args = {}, { config = {}, root = process.cwd(), lastMedia = [] } = {}) {
  const cfg = visionConfig(config);
  if (!cfg.url || !cfg.key) {
    return toolResult({ ok: false, error: '未配置视觉模型：设 EXISTEON_VISION_URL / EXISTEON_VISION_KEY，或 config.vision' });
  }
  const img = resolveImage(args, { root, lastMedia });
  if (!img.ok) return toolResult({ ok: false, error: img.error });

  const prompt = String(args.prompt || '用一两句话描述这张图里有什么；如果有文字，把关键文字读出来。');
  const body = {
    model: cfg.model,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: img.url } },
      ],
    }],
    max_tokens: 300,
  };

  try {
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return toolResult({ ok: false, error: j.error?.message || `HTTP ${res.status}` });
    const text = String(j.choices?.[0]?.message?.content || '').trim();
    if (!text) return toolResult({ ok: false, error: '视觉模型返回空' });
    return toolResult({ ok: true, data: { text, model: cfg.model } });
  } catch (e) {
    return toolResult({ ok: false, error: '视觉请求失败：' + String(e?.message || e) });
  }
}
