/**
 * 灵魂侧的小文件存储（JSON / JSONL）
 *
 * 之前每个模块各写一遍 fs.readFileSync + try/catch + mkdir，
 * 这里收成 5 个函数；只处理 UTF-8，不抛错（读写失败返回兜底）。
 */
import fs from 'node:fs';
import path from 'node:path';

function stripBom(v) {
  const t = String(v ?? '');
  return t.charCodeAt(0) === 0xfeff ? t.slice(1) : t;
}

export function readText(file, fallback = '') {
  try { return stripBom(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function writeText(file, text) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, String(text));
    return true;
  } catch { return false; }
}

export function appendText(file, text) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, String(text));
    return true;
  } catch { return false; }
}

/** 先写 .tmp 再改名（笔记整表重写用） */
export function writeTextAtomic(file, text) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, String(text));
    fs.renameSync(tmp, file);
    return true;
  } catch { return false; }
}

export function listFiles(dir, ext = '') {
  try {
    return fs.readdirSync(dir).filter((f) => !ext || f.endsWith(ext));
  } catch { return []; }
}

/** 文件不存在就建一个带头部的文件 */
export function ensureText(file, header) {
  try {
    if (fs.existsSync(file)) return true;
    return writeText(file, header);
  } catch { return false; }
}

export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function writeJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    return true;
  } catch { return false; }
}

export function readJsonl(file, limit = Infinity) {
  try {
    const rows = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
    return Number.isFinite(limit) ? rows.slice(-limit) : rows;
  } catch { return []; }
}

export function writeJsonl(file, rows, { keep = Infinity } = {}) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const out = Number.isFinite(keep) ? rows.slice(-keep) : rows;
    fs.writeFileSync(file, out.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return true;
  } catch { return false; }
}

export function appendJsonl(file, row, { keep = Infinity } = {}) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(row) + '\n');
    if (Number.isFinite(keep)) {
      const rows = readJsonl(file);
      if (rows.length > keep) writeJsonl(file, rows, { keep });
    }
    return true;
  } catch { return false; }
}
