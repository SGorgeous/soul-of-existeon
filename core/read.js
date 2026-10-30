import fs from 'node:fs';

/**
 * 读 UTF-8 文本并去掉 BOM。
 * PowerShell 的 Set-Content/ConvertTo-Json 会写 BOM，JSON.parse 读到 BOM 会直接抛，
 * 表现为「文件在，但读出来是空的」。所有状态文件都走这里。
 */
export function stripBom(s) {
  const t = String(s ?? '');
  return t.charCodeAt(0) === 0xfeff ? t.slice(1) : t;
}

export function readUtf8(file) {
  return stripBom(fs.readFileSync(file, 'utf8'));
}

/** 读 JSON（带 BOM 容忍）；读不到/坏了返回 fallback */
export function readJson(file, fallback = null) {
  try { return JSON.parse(readUtf8(file)); } catch { return fallback; }
}
