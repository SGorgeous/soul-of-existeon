/** 漫游用的模型请求（只负责发一次，解析 JSON 动作） */
export async function askRoamModel({ brain, brainChoice, cfg = {}, system, user }) {
  if (!brainChoice?.deepseek || !brain?.apiKey) return null;
  const payload = {
    model: cfg.model || brain.model || 'deepseek-chat',
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    max_tokens: Number(cfg.maxTokens) || 260,
    temperature: 0.95,
    stream: false,
  };
  const res = await fetch(brain.base, {
    method: 'POST',
    headers: { Authorization: `Bearer ${brain.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(45000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error?.message || ('HTTP ' + res.status));
  const text = String(j.choices?.[0]?.message?.content || '').trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj = null;
  try { obj = JSON.parse(m[0]); } catch { return null; }
  const kinds = new Set(['diary', 'note', 'search', 'soak', 'sun', 'eat', 'nap', 'think']);
  if (!obj || !kinds.has(obj.action)) return null;
  const out = {
    action: obj.action,
    desire: String(obj.desire || '').slice(0, 20),
    text: String(obj.text || '').trim().slice(0, 900),
    query: String(obj.query || '').trim().slice(0, 60),
    by: 'model',
  };
  if (out.action === 'search' && !out.query) out.action = 'think';
  return out;
}
