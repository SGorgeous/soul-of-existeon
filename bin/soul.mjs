/**
 * 最小可运行的灵魂内核（无虚拟世界、无 Web 适配器）。
 *
 * 用法：
 *   node bin/soul.mjs
 *   DEEPSEEK_API_KEY=sk-... node bin/soul.mjs
 *   node bin/soul.mjs --key=sk-... --model=deepseek-chat
 *
 * 没有 API key 时用 MockBrain，只演示流程，不产生真实回复。
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Kernel } from '../core/kernel.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (name, fallback = '') => {
  const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : args[args.indexOf(hit) + 1] || fallback;
};

// 读取 .env（KEY=VALUE，不覆盖已有环境变量）
function loadDotEnv(file) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m || m[1].startsWith('#')) continue;
      const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
      if (!(m[1] in process.env)) process.env[m[1]] = value;
    }
  } catch { /* 没有 .env 也行 */ }
}
loadDotEnv(path.join(ROOT, '.env'));

const key = arg('key', '') || process.env.DEEPSEEK_API_KEY || process.env.EXISTEON_DS_KEY || '';
if (key) process.env.EXISTEON_DS_KEY = key;
const model = arg('model', '') || process.env.DEEPSEEK_MODEL || '';
const base = arg('base', '') || process.env.DEEPSEEK_BASE_URL || '';
const soulId = arg('soul', '') || process.env.SOUL_ID || '';
const root = path.resolve(arg('root', '') || process.env.SOUL_ROOT || ROOT);

const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'default.json'), 'utf8'));
config.brain = { ...(config.brain || {}), kind: key ? 'deepseek' : 'mock' };
if (model) config.brain.model = model;
if (base) config.brain.base = base;
config.roam = { ...(config.roam || {}), enabled: false };
config.spaceChat = { ...(config.spaceChat || {}), enabled: false };
config.gate = { ...(config.gate || {}), whitelist: ['terminal:*'] };

fs.mkdirSync(root, { recursive: true });
const kernel = new Kernel({ root, config });

// 内核不自带世界：把依赖世界的工具拿掉，避免模型调用后报“世界未装配”
for (const name of ['look', 'listen', 'walk_to', 'say_to']) kernel.tools.tools.delete(name);

const id = soulId || kernel.defaultSoul;
if (!kernel.souls.exists(id)) {
  console.error(`没有这个灵魂：${id}`);
  console.error('可用灵魂：' + kernel.souls.list().map((s) => s.id).join(', '));
  process.exit(1);
}

console.log('=== soul-of-existeon ===');
console.log('灵魂：' + id + ' · 模型：' + (key ? (config.brain.model || 'deepseek-chat') : 'MockBrain（没有 API key）'));
console.log('API key：' + (key ? '已加载（' + key.slice(0, 6) + '…' + key.slice(-4) + '）' : '未设置（只在本地演示）'));
console.log('数据目录：' + root);
console.log('输入内容回车发送；Ctrl+C 退出。\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '你> ' });
rl.prompt();

rl.on('line', async (line) => {
  const text = line.trim();
  if (!text) { rl.prompt(); return; }
  if (text === '/quit' || text === '/exit') { rl.close(); return; }
  rl.pause();
  try {
    const turn = await kernel.runTurn({ channel: 'terminal:main', text, soulId: id });
    const replies = (turn.replies || []).filter((x) => String(x || '').trim());
    if (replies.length) {
      for (const r of replies) console.log('\n' + id + '：' + r + '\n');
    } else if (turn.skipped) {
      console.log('\n（跳过：' + turn.skipped + '）\n');
    } else if (turn.quiet) {
      console.log('\n（她没有说话）\n');
    } else {
      console.log('\n（没有回复）\n');
    }
  } catch (e) {
    console.error('\n出错了：' + (e?.message || e) + '\n');
  } finally {
    rl.resume();
    rl.prompt();
  }
});

rl.on('close', () => {
  console.log('\n再见。');
  process.exit(0);
});
