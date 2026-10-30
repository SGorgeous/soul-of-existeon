import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Growth } from '../mind/learning/growth.js';
import { Learning } from '../mind/learning/curriculum.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'existeon-learning-'));
const growth = new Growth({ root });
const soul = 'vaporeon';
const now = Date.now();

// 1) 兴趣写入 → 自动出现学习目标
growth.noteInterest(soul, '深海生物发光');
const goals = growth.learning.snapshot(soul, now).goals;
assert.equal(goals.length, 1);
assert.equal(goals[0].topic, '深海生物发光');

// 2) 刚学完不会立刻“到期”
assert.equal(growth.learning.due(soul, now).length, 0);

// 3) 刚写入时已是第 1 阶段，下次在 1 天后
const goal = growth.learning.active(soul);
assert.equal(goal.stage, 1);
assert.ok(goal.nextAt > now, '要排下一次复习');

// 4) 到期后能给出“先回忆”的提示
const later = now + 2 * 86400_000;
assert.equal(growth.learning.due(soul, later).length, 1);
const line = growth.learning.line(soul, later);
assert.match(line, /学习复习|先别急着查/);

// 5) 复习后再推进，间隔变长
const g2 = growth.learning.observeTopic(soul, '深海生物发光', later);
assert.equal(g2.stage, 2);
assert.ok(g2.nextAt - later >= 3 * 86400_000, '第二次间隔应 ≥ 3 天');

// 6) 关掉/空数据不炸
const empty = new Learning({ root: fs.mkdtempSync(path.join(os.tmpdir(), 'existeon-learning2-')) });
assert.deepEqual(empty.due('nobody'), []);
assert.equal(empty.line('nobody'), '');

fs.rmSync(root, { recursive: true, force: true });
console.log('learning 通过 → 兴趣成目标 / 到期复习 / 间隔递增 / 空数据安全');
