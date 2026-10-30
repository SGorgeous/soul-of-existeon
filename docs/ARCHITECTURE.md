# 内核结构

```
bin/soul.mjs        CLI 入口（读 .env / 环境变量 / --key）
core/
  kernel.js         Turn 入口、装配、bindWorld
  pipeline.js       门禁 → 上下文 → 推理 → 工具 → 组合 → 投递
  gate.js           频率 / 白名单 / 体力
  policy.js         停止策略
  sessions.js       会话
  soul-runtime.js   单灵魂运行时（context/records/memory/facts/people）
  souls.js          灵魂档案
  contracts.js      内部契约
mind/
  brain.js          模型调用（Mock / DeepSeek 兼容）
  reasoner.js       工具循环
  context.js        上下文构建（人格/记忆/事实/感官/成长）
  memory/           Memory / Facts / People / Records
  learning/         reward / habits / growth
  reflex/           反射引擎与 DSL
  actors/roamer    主动漫游（可关）
physiology/         精力 / 睡眠
reflection/         事后反思
tools/              工具注册表与内置工具
```

## 数据流

```
输入 → Gate → ContextBuilder → Reasoner（模型/工具循环）
     → Composer → Policy（停/续）→ Deliver → 记录/反思/奖励/成长
```

## 与世界的边界

- 内核只通过 `kernel.bindWorld(WorldPort)` 获取感官与动作；没有世界时 `senses()` 返回空。
- `look/listen/walk_to/say_to` 在没有世界时会明确报“世界还没装配”，不会假装成功。
- 世界侧只通过 `MindPort` 调 `runTurn`；两边互不 import 具体类。

## 数据落盘

全部在 `SOUL_ROOT`（默认仓库根目录）下的 `state/souls/<id>/`：

```
persona.md  memory.jsonl  facts/  people/  diary/  records/
sessions/   rewards.jsonl habits.jsonl growth.json interests.jsonl
```

`state/` 已被 `.gitignore` 忽略，不会进仓库。
