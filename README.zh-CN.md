<p align="center">
  <a href="./README.md"><strong>English</strong></a>&nbsp;&nbsp;|&nbsp;&nbsp;<strong>中文文档</strong>
</p>

<p align="center">
  <img src="./assets/github-banner.svg" alt="CC Telegram Bridge" width="100%" />
</p>

<p align="center">
  <a href="https://github.com/cloveric/cc-telegram-bridge/blob/main/LICENSE"><img src="https://img.shields.io/github/license/cloveric/cc-telegram-bridge?style=flat-square&color=818cf8" alt="License"></a>
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178c6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D20-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js">
  <img src="https://img.shields.io/badge/%E5%B9%B3%E5%8F%B0-Windows%20%7C%20macOS%20%7C%20Linux-0078D4?style=flat-square&logo=node.js&logoColor=white" alt="Windows | macOS | Linux">
  <img src="https://img.shields.io/badge/%E5%BC%95%E6%93%8E-Codex%20%7C%20Claude-F97316?style=flat-square" alt="Codex | Claude">
  <img src="https://img.shields.io/badge/%E6%B5%8B%E8%AF%95-Vitest-6E9F18?style=flat-square&logo=vitest&logoColor=white" alt="Vitest">
</p>

<h3 align="center">
  在 Telegram 上运行 AI 编程 agent 舰队 — 由 Codex 或 Claude Code 驱动。<br>
  每个 bot 拥有独立的引擎、人格、状态和访问控制。<br>
  <sub>类似 <a href="https://github.com/openclaw">OpenClaw</a> 的体验，但专为 Codex 和 Claude 设计。</sub>
</h3>

<p align="center">
  <a href="#-双引擎">双引擎</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#-多-bot-部署">多 Bot</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#-agent-指令">agent.md</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#-yolo-模式">YOLO</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#-用量追踪">用量</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#-快速开始">快速开始</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#-docker">Docker</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#-服务运维">运维</a>
</p>

> **RULE 1：** 让你的 Claude Code 或 Codex CLI 来帮你配置这个项目。克隆仓库，在终端里打开，然后告诉你的 AI agent：*"读一下 README，帮我配置一个 Telegram bot"*。剩下的它会搞定。

---

## 双引擎：Codex + Claude Code

每个 bot 实例可以独立选择 **OpenAI Codex** 或 **Claude Code** 作为后端引擎，一条命令即可切换：

```bash
# 将某个实例设为 Claude Code
npm run dev -- telegram engine claude --instance review-bot

# 将另一个设为 Codex
npm run dev -- telegram engine codex --instance helper-bot

# 查看当前引擎
npm run dev -- telegram engine --instance review-bot
```

| 特性 | Codex 引擎 | Claude 引擎 |
|---|---|---|
| CLI 命令 | `codex exec --json` | `claude -p --output-format json` |
| 会话恢复 | `codex exec resume --json <id>` | `claude -p -r <session-id>` |
| 项目指令 | `agent.md`（注入到 prompt） | `agent.md`（`--system-prompt`）+ `CLAUDE.md`（工作目录自动加载） |
| YOLO 模式 | `--full-auto` / `--dangerously-bypass-*` | `--permission-mode bypassPermissions` / `--dangerously-skip-permissions` |
| 工作目录 | 无 | 实例目录下的 `workspace/`（放 `CLAUDE.md`） |

### Claude 引擎：CLAUDE.md 支持

使用 Claude 引擎时，每个实例会有一个 `workspace/` 目录。在里面放一个 `CLAUDE.md` 就能定义项目级指令：

```
~/.codex/channels/telegram/review-bot/
├── agent.md              ← "你是一个严格的代码审查员"
├── workspace/
│   └── CLAUDE.md         ← "TypeScript 项目，用 ESLint，不要改测试文件"
├── config.json           ← { "engine": "claude", "approvalMode": "full-auto" }
└── .env
```

两层指令互不冲突：
- **agent.md** → bot 人格（通过 `--system-prompt` 注入）
- **CLAUDE.md** → 项目规则（Claude 从工作目录自动发现）

---

## 多 Bot 部署

想开多少个 bot 就开多少个。每个实例完全隔离 — 独立的引擎、token、人格、线程、访问规则、收件箱和审计日志。

```
          ┌─────────────────────────────────────────────┐
          │            cc-telegram-bridge                │
          └────────────┬──────────────┬─────────────────┘
                       │              │
        ┌──────────────┼──────────────┼──────────────┐
        ▼              ▼              ▼              ▼
 ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐
 │  "default" │ │   "work"   │ │ "reviewer" │ │ "research" │
 │  引擎:     │ │  引擎:     │ │  引擎:     │ │  引擎:     │
 │   codex    │ │   codex    │ │   claude   │ │   claude   │
 │            │ │            │ │            │ │            │
 │ agent.md:  │ │ agent.md:  │ │ agent.md:  │ │ agent.md:  │
 │ "通用助手" │ │ "中文回复" │ │ "严格审查" │ │ "深度研究" │
 └────────────┘ └────────────┘ └────────────┘ └────────────┘
   PID 4821       PID 5102       PID 5340       PID 5520
```

### 30 秒部署

```bash
# 配置各实例
npm run dev -- telegram configure <token-A>
npm run dev -- telegram configure --instance work <token-B>
npm run dev -- telegram configure --instance reviewer <token-C>

# 设置引擎
npm run dev -- telegram engine claude --instance reviewer

# 设置人格
npm run dev -- telegram instructions set --instance reviewer ./reviewer-instructions.md

# 给手机用开启 YOLO
npm run dev -- telegram yolo on --instance work

# 全部启动
npm run dev -- telegram service start
npm run dev -- telegram service start --instance work
npm run dev -- telegram service start --instance reviewer
```

---

## Agent 指令

每个 bot 有自己的 `agent.md`。每条消息都会重新加载 — 随时编辑，无需重启。

```bash
npm run dev -- telegram instructions show --instance work
npm run dev -- telegram instructions set --instance work ./my-instructions.md
npm run dev -- telegram instructions path --instance work
```

也可以直接编辑文件：

```bash
# Windows
notepad %USERPROFILE%\.codex\channels\telegram\work\agent.md

# macOS
open -e ~/.codex/channels/telegram/work/agent.md
```

---

## YOLO 模式

```bash
npm run dev -- telegram yolo on --instance work      # 安全自动审批
npm run dev -- telegram yolo unsafe --instance work   # 跳过所有检查
npm run dev -- telegram yolo off --instance work      # 恢复正常流程
npm run dev -- telegram yolo --instance work          # 查看状态
```

| 模式 | Codex | Claude | 适用场景 |
|---|---|---|---|
| `off` | 正常审批 | 正常审批 | 默认，最安全 |
| `on` | `--full-auto` | `--permission-mode bypassPermissions` | 手机操作 |
| `unsafe` | `--dangerously-bypass-*` | `--dangerously-skip-permissions` | 仅限可信环境 |

热加载 — 不用重启 bot，CLI 切一下立刻生效。

---

## 用量追踪

按实例追踪 token 消耗和费用：

```bash
npm run dev -- telegram usage                    # 默认实例
npm run dev -- telegram usage --instance work    # 指定实例
```

输出：
```
Instance: work
Requests: 42
Input tokens: 185,230
Output tokens: 12,450
Cached tokens: 96,000
Estimated cost: $0.3521
Last updated: 2026-04-09T10:00:00Z
```

Claude 报告精确 USD 费用，Codex 仅报告 token 数。

---

## 详细度控制

控制流式进度显示的精细程度：

```bash
npm run dev -- telegram verbosity 0 --instance work   # 安静 — 无实时更新
npm run dev -- telegram verbosity 1 --instance work   # 正常 — 每 2 秒更新（默认）
npm run dev -- telegram verbosity 2 --instance work   # 详细 — 每 1 秒更新
npm run dev -- telegram verbosity --instance work      # 查看当前级别
```

存储在 `config.json`，热加载生效。

---

## 快速开始

### 环境要求

- **Node.js** >= 20
- **OpenAI Codex CLI** 和/或 **Claude Code CLI** 已安装并认证
- 一个 **Telegram Bot Token**（从 [@BotFather](https://t.me/BotFather) 获取）

### 安装

```bash
git clone https://github.com/cloveric/cc-telegram-bridge.git
cd cc-telegram-bridge
npm install
npm run build
```

### 单 Bot（最简单）

```bash
npm run dev -- telegram configure <your-bot-token>
npm run dev -- telegram service start
```

### Claude Bot

```bash
npm run dev -- telegram configure --instance claude-bot <token>
npm run dev -- telegram engine claude --instance claude-bot
npm run dev -- telegram service start --instance claude-bot
```

---

## 架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                         cc-telegram-bridge                          │
├─────────────┬──────────────┬──────────────────┬─────────────────────┤
│  Telegram   │   运行时     │     AI 引擎      │      状态           │
│  层         │   层         │     层           │      层             │
├─────────────┼──────────────┼──────────────────┼─────────────────────┤
│ api.ts      │ bridge.ts    │ adapter.ts       │ access-store.ts     │
│ delivery.ts │ chat-queue.ts│ process-adapter  │ session-store.ts    │
│ update-     │ session-     │   .ts (Codex)    │ runtime-state.ts    │
│ normalizer  │ manager.ts   │ claude-adapter   │ instance-lock.ts    │
│   .ts       │              │   .ts (Claude)   │ json-store.ts       │
│ message-    │              │                  │ audit-log.ts        │
│ renderer.ts │              │ agent.md + config│                     │
└─────────────┴──────────────┴──────────────────┴─────────────────────┘
```

**数据流：**

```
Telegram 消息 → 标准化 → 访问检查 → 聊天队列（串行）
    → 加载 config.json（引擎） → 加载 agent.md → 会话查找
    → Codex Exec 或 Claude -p（新建或恢复）
    → 流式进度更新（每 2 秒） → 最终渲染 → 发送 → 审计
```

---

## 亮点

<table>
  <tr>
    <td width="50%">
      <h3>双引擎</h3>
      <p>每个实例可切换 Codex 和 Claude Code。混合搭配 — 一个 bot 跑 Codex，另一个跑 Claude，统一 CLI 管理。</p>
    </td>
    <td width="50%">
      <h3>独立人格</h3>
      <p>每个实例加载自己的 <code>agent.md</code>。Claude 实例还支持 <code>CLAUDE.md</code> 项目规则。</p>
    </td>
  </tr>
  <tr>
    <td>
      <h3>流式进度</h3>
      <p>AI 生成回复时，Telegram 消息每 2 秒实时更新，不再干等 "Running..."。</p>
    </td>
    <td>
      <h3>YOLO 模式</h3>
      <p>一条命令让 AI 自动审批一切 — 双引擎通用，按实例配置，热加载生效。</p>
    </td>
  </tr>
  <tr>
    <td>
      <h3>完全隔离</h3>
      <p>每个实例：独立引擎、token、访问控制、会话、线程、收件箱、审计日志、<strong>引擎记忆</strong>。bot 之间零串台。</p>
    </td>
    <td>
      <h3>生产级可靠性</h3>
      <p>长轮询（~0ms 延迟）、指数退避、429 自动重试、409 冲突自动退出、SIGTERM/SIGINT 优雅关闭、容错批处理。</p>
    </td>
  </tr>
  <tr>
    <td>
      <h3>用量追踪</h3>
      <p>按实例统计 token 消耗和 USD 费用。<code>telegram usage</code> 随时查看花费。</p>
    </td>
    <td>
      <h3>详细度控制</h3>
      <p>按实例设置输出级别：0 = 安静，1 = 正常（2 秒），2 = 详细（1 秒）。</p>
    </td>
  </tr>
  <tr>
    <td>
      <h3>完整审计日志</h3>
      <p>每个实例独立的 JSONL 追加日志 — 支持按类型、聊天、结果过滤。</p>
    </td>
    <td>
      <h3>Docker 就绪</h3>
      <p>内含多阶段 Dockerfile，一次构建，随处部署。</p>
    </td>
  </tr>
</table>

---

## 服务运维

| 命令 | 说明 |
|---|---|
| `telegram service start` | 获取锁、加载状态、启动长轮询 |
| `telegram service stop` | 优雅关闭（SIGTERM/SIGINT） |
| `telegram service status` | 运行状态、PID、引擎、bot 身份、审计健康 |
| `telegram service restart` | 停止 + 启动，干净重置 |
| `telegram service logs` | 查看 stdout/stderr 日志 |
| `telegram service doctor` | 全子系统健康检查 |
| `telegram engine [codex\|claude]` | 按实例切换 AI 引擎 |
| `telegram yolo [on\|off\|unsafe]` | 切换自动审批模式 |
| `telegram usage` | 查看 token 用量和费用估算 |
| `telegram verbosity [0\|1\|2]` | 设置流式进度显示级别 |
| `telegram help` | 显示所有可用命令 |

所有命令支持 `--instance <name>` 指定目标 bot。

## 稳定 Beta 命令

- `telegram service doctor --instance <name>`
- `telegram session list --instance <name>`
- `telegram session inspect --instance <name> <chat-id>`
- `telegram session reset --instance <name> <chat-id>`
- `telegram task list --instance <name>`
- `telegram task inspect --instance <name> <upload-id>`
- `telegram task clear --instance <name> <upload-id>`

Telegram 用户也可以使用：

- `/status`
- `/continue`
- `/reset`
- `/help`

针对压缩包摘要，推荐直接回复该摘要或点击其中的 Continue Analysis 按钮继续；裸 `/continue` 只会恢复最近一个等待中的压缩包。

状态文件损坏时的恢复行为：

- 当 `session.json` 或 `file-workflow.json` 不可读时，`telegram service status` 和 `telegram service doctor` 会降级为 `unknown (...)` 警告，而不是直接崩溃。
- `telegram session inspect` 和 `telegram task inspect` 会提示状态不可读并直接停止，不会假装记录不存在。
- `telegram session reset`、`telegram task clear` 以及 Telegram `/reset` 只会在文件损坏或结构非法时自愈；写入默认空状态前，会先把原始不可读文件隔离备份到同目录。
- Telegram `/status` 在底层 JSON 不可读时，会把 session/task 状态显示为 `unknown (...)`。

### Shell 辅助脚本

**Windows (PowerShell):**

```powershell
.\scripts\start-instance.ps1 [-Instance work]
.\scripts\status-instance.ps1 [-Instance work]
.\scripts\stop-instance.ps1 [-Instance work]
```

**macOS / Linux (bash):**

```bash
./scripts/start-instance.sh [work]
./scripts/status-instance.sh [work]
./scripts/stop-instance.sh [work]
```

---

## 访问控制

按实例分两层：**配对**（初始握手）+ **白名单**（持续授权）。

```bash
npm run dev -- telegram access pair <code>
npm run dev -- telegram access policy allowlist
npm run dev -- telegram access allow <chat-id>
npm run dev -- telegram access revoke <chat-id>
npm run dev -- telegram status [--instance work]
```

---

## 会话检视

```bash
npm run dev -- telegram session inspect [--instance work] <chat-id>
npm run dev -- telegram session reset [--instance work] <chat-id>
```

---

## 审计日志

每个实例独立的 JSONL 追加日志，支持过滤查询：

```bash
npm run dev -- telegram audit [--instance work]
npm run dev -- telegram audit 50                                    # 最近 50 条
npm run dev -- telegram audit --type update.handle --outcome error  # 按类型/结果过滤
npm run dev -- telegram audit --chat 688567588                      # 按聊天过滤
```

---

## 状态目录

```
# Windows: %USERPROFILE%\.codex\channels\telegram\<instance>\
# macOS/Linux: ~/.codex/channels/telegram/<instance>/

<instance>/
├── agent.md                # Bot 人格与指令
├── config.json             # 引擎、YOLO 模式、详细度
├── usage.json              # Token 用量和费用追踪
├── engine-home/            # 隔离的引擎配置、记忆、会话
│   ├── memory/             # Claude: 自动记忆 (CLAUDE_CONFIG_DIR)
│   ├── sessions/           # Codex: 线程历史 (CODEX_HOME)
│   └── ...                 # 每个 bot 的引擎状态完全隔离
├── workspace/              # Claude 工作目录（仅 Claude 引擎）
│   └── CLAUDE.md           # Claude Code 项目指令
├── .env                    # Bot token
├── access.json             # 配对 + 白名单数据
├── session.json            # 聊天到线程的绑定
├── runtime-state.json      # 水位线、偏移量
├── instance.lock.json      # 进程锁
├── audit.log.jsonl         # 结构化审计流
├── service.stdout.log      # 服务 stdout
├── service.stderr.log      # 服务 stderr
└── inbox/                  # 下载的附件
```

---

## 开发

```bash
npm run dev -- <command>     # 开发模式
npm test                     # 运行测试
npm run test:watch           # 监听模式
npm run build                # 构建生产版本
npm start                    # 启动生产版本
```

---

## Docker

```bash
# 构建
docker build -t cc-telegram-bridge .

# 运行
docker run -v ~/.codex:/root/.codex cc-telegram-bridge telegram configure <token>
docker run -v ~/.codex:/root/.codex cc-telegram-bridge telegram service start
```

挂载 `~/.codex` 以在容器重启后保留状态。

---

## 故障排查

<details>
<summary><strong>Bot 不回复</strong></summary>

1. 运行 `telegram service doctor` 诊断
2. 查看 `telegram service logs` 的错误
3. 确认引擎已安装：`codex --version` 或 `claude --version`

</details>

<details>
<summary><strong>Bot 发送重复回复</strong></summary>

409 Conflict 说明两个进程在轮询同一个 bot token。服务会自动检测并退出。运行 `telegram service status` 检查，然后 `telegram service stop` + `telegram service start` 干净重启。

</details>

<details>
<summary><strong>切换到 Claude 引擎</strong></summary>

1. `telegram engine claude --instance <name>`
2. 重启服务：`telegram service restart --instance <name>`
3. 可选：在 workspace 目录添加 `CLAUDE.md`

</details>

<details>
<summary><strong>agent.md 修改不生效</strong></summary>

不需要重启 — 每条消息都会重新加载。用 `telegram instructions path --instance <name>` 确认路径。

</details>

---

## 许可证

[MIT](./LICENSE)

---

<p align="center">
  <sub>你的 agent。你的引擎。你的规则。</sub>
</p>
