# soul-of-existeon

一个**灵魂内核**：Turn 流水线、人格、记忆、心情、反思、工具调用、奖励 / 习惯 / 成长。
不包含虚拟世界、Web UI、QQ/B站适配器，也不包含任何密钥或运行时数据。

> 这是从 [existeon](https://github.com/) 里抽出来的内核部分；世界（房间、走动、感官）在另一个仓库/目录里，通过 `WorldPort` 接入。

## 快速开始

```bash
# Node >= 22.13
git clone https://github.com/<you>/soul-of-existeon.git
cd soul-of-existeon

# 方式 1：环境变量
DEEPSEEK_API_KEY=sk-... npm start

# 方式 2：.env（会被 .gitignore 忽略）
cp .env.example .env
# 编辑 .env，填入 DEEPSEEK_API_KEY
npm start
```

启动后是终端对话：

```
你> 今天有点累
水伊布：……那就先别硬撑。过来，尾巴借你靠一会儿。
```

没有 API key 时会用 `MockBrain`，只演示流程，不会产生真实回复。

### 用别的兼容 API

```bash
DEEPSEEK_API_KEY=sk-... \
DEEPSEEK_BASE_URL=https://api.deepseek.com \
DEEPSEEK_MODEL=deepseek-chat \
npm start
```

也可以：

```bash
node bin/soul.mjs --key=sk-... --base=https://api.deepseek.com --model=deepseek-chat
```

> key 只放在环境变量或 `.env` 里，代码和仓库里没有任何 key。

## 内核里有什么

| 目录 | 作用 |
|---|---|
`core/` | Turn 流水线、门禁、停止策略、会话、灵魂运行时 |
`mind/` | 大脑、上下文、记忆、事实、日记/笔记、心情、反思、工具、奖励/习惯/成长、主动漫游 |
`physiology/` | 精力 / 睡眠 / 生理节律 |
`reflection/` | 事后反思（下一轮的“教训”） |
`tools/` | 工具注册表与内置工具（时间、记忆、笔记、日记、搜索、视觉…） |
`config/default.json` | 全部可调参数（已去掉 Web/QQ 配置） |
`bin/soul.mjs` | 最小 CLI 入口 |
`test/kernel-smoke.mjs` | 无世界的最小回归 |

## 设计边界

- 内核**不依赖世界**：感官由 `kernel.bindWorld(WorldPort)` 注入；没有世界时 `senses()` 为空，空间类工具会被移除。
- 记忆、日记、笔记都落在 `state/souls/<id>/`，默认在仓库下的 `state/`（已 gitignore）。
- 奖励 / 习惯 / 成长是灵魂侧数据（`rewards.jsonl` / `habits.jsonl` / `growth.json`），不包含在仓库里。

## 测试

```bash
npm test
```

## License

MIT
