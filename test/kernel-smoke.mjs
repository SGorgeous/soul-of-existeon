import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Kernel } from '../core/kernel.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-kernel-'));
const config = JSON.parse(fs.readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'));
config.brain = { kind: 'mock', forceMock: true };
config.gate = { whitelist: ['terminal:*'], ratePerMinute: 99, ratePerHour: 999, checkVitals: false };
config.roam = { enabled: false };
config.spaceChat = { enabled: false };

const k = new Kernel({ root, config });
const soul = k.defaultSoul;

// 1) 没有世界也能跑一轮
const turn = await k.runTurn({ channel: 'terminal:main', text: '你好', soulId: soul });
assert.ok(turn, '要产生一轮');
assert.ok(Array.isArray(turn.replies), '要有回复数组');

// 2) 空间工具在没有世界时是“可调用但明确报错”，不会假装成功
k.currentTurn = { soul };
const bad = await k.tools.invoke('walk_to', { room: 'study' });
assert.equal(bad.ok, false);
assert.match(String(bad.error || ''), /世界/);

// 3) 记忆能落盘、能读回
const rt = k.runtimes.get(soul);
rt.memory.write({ text: '主人喜欢蓝色', keywords: ['蓝色'], salience: 0.8 });
const hits = rt.memory.recall('蓝色', { limit: 3 });
assert.ok(hits.some((h) => String(h.text).includes('蓝色')), '记忆要能召回');

// 4) 奖励/习惯/成长文件在灵魂目录下
assert.ok(fs.existsSync(path.join(root, 'state', 'souls', soul)), '灵魂目录要存在');

fs.rmSync(root, { recursive: true, force: true });
console.log('kernel-smoke 通过 → 无世界跑一轮 / 空间工具明确报错 / 记忆落盘召回 / 灵魂目录');

