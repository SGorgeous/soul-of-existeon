/** 漫游状态落盘（roam.json / roam.jsonl） */
import fs from 'node:fs';
import path from 'node:path';

export function emptyState() {
  return {
    lastTickAt: 0, day: '', counts: { day: 0, hour: 0, hourAt: 0, search: 0, outbound: 0 },
    pendingThought: '', lastThought: null, lastOutboundAt: 0, total: 0,
  };
}

export function loadState(file) {
  const empty = emptyState();
  if (!file) return empty;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ...empty, ...(j && typeof j === 'object' ? j : {}) };
  } catch { return empty; }
}

export function saveState(file, state) {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2));
  } catch { /* 写不下也不影响她 */ }
}

export function appendLog(file, row) {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(row) + '\n');
  } catch { /* ignore */ }
}
