<p align="center">
  <img src="./assets/github-banner.svg" alt="CC Telegram Bridge" width="100%" />
</p>

<p align="center">
  <a href="https://github.com/cloveric/cc-telegram-bridge/blob/main/LICENSE"><img src="https://img.shields.io/github/license/cloveric/cc-telegram-bridge?style=flat-square&color=818cf8" alt="License"></a>
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178c6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D20-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js">
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-0078D4?style=flat-square&logo=node.js&logoColor=white" alt="Windows | macOS | Linux">
  <img src="https://img.shields.io/badge/engines-Codex%20%7C%20Claude-F97316?style=flat-square" alt="Codex | Claude">
  <img src="https://img.shields.io/badge/tests-Vitest-6E9F18?style=flat-square&logo=vitest&logoColor=white" alt="Vitest">
</p>

<h3 align="center">
  Run a fleet of AI coding agents on Telegram — powered by Codex or Claude Code.<br>
  Each bot gets its own engine, personality, state, and access control.<br>
  <sub>Think <a href="https://github.com/openclaw">OpenClaw</a>, but for Codex and Claude over Telegram.</sub>
</h3>

<p align="center">
  <a href="#-dual-engine">Dual Engine</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#-multi-bot-setup">Multi-Bot</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#-agent-instructions">agent.md</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#-yolo-mode">YOLO</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#-quick-start">Quick Start</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#-architecture">Architecture</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#-service-operations">Ops</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#-access-control">Access</a>
</p>

---

## Dual Engine: Codex + Claude Code

Each bot instance can run either **OpenAI Codex** or **Claude Code** as its backend. Switch engines per-instance with one command:

```powershell
# Set an instance to use Claude Code
npm run dev -- telegram engine claude --instance review-bot

# Set another to use Codex
npm run dev -- telegram engine codex --instance helper-bot

# Check current engine
npm run dev -- telegram engine --instance review-bot
```

| Feature | Codex Engine | Claude Engine |
|---|---|---|
| CLI command | `codex exec --json` | `claude -p --output-format json` |
| Session resume | `codex exec resume --json <id>` | `claude -p -r <session-id>` |
| Project instructions | `agent.md` (prepended to prompt) | `agent.md` (via `--system-prompt`) + `CLAUDE.md` (auto-loaded from workspace) |
| YOLO mode | `--full-auto` / `--dangerously-bypass-approvals-and-sandbox` | `--permission-mode bypassPermissions` / `--dangerously-skip-permissions` |
| Working directory | N/A | `workspace/` under instance dir (with `CLAUDE.md`) |

### Claude Engine: CLAUDE.md Support

When using the Claude engine, each instance gets a `workspace/` directory. Drop a `CLAUDE.md` in there for project-level instructions that Claude Code reads natively:

```
~/.codex/channels/telegram/review-bot/
├── agent.md              ← "You are a strict code reviewer"
├── workspace/
│   └── CLAUDE.md         ← "TypeScript project. Use ESLint. Never modify tests."
├── config.json           ← { "engine": "claude", "approvalMode": "full-auto" }
└── .env
```

Two layers of instructions, no conflict:
- **agent.md** → Your bot personality (injected via `--system-prompt`)
- **CLAUDE.md** → Project rules (Claude auto-discovers from working directory)

---

## Multi-Bot Setup

Run as many bots as you need. Each instance is fully isolated — its own engine, token, personality, threads, access rules, inbox, and audit trail.

```
          ┌─────────────────────────────────────────────┐
          │          cc-telegram-bridge              │
          └────────────┬──────────────┬─────────────────┘
                       │              │
        ┌──────────────┼──────────────┼──────────────┐
        ▼              ▼              ▼              ▼
 ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐
 │  "default" │ │   "work"   │ │ "reviewer" │ │ "research" │
 │  engine:   │ │  engine:   │ │  engine:   │ │  engine:   │
 │   codex    │ │   codex    │ │   claude   │ │   claude   │
 │            │ │            │ │            │ │            │
 │ agent.md:  │ │ agent.md:  │ │ agent.md:  │ │ agent.md:  │
 │ "General   │ │ "Reply in  │ │ "Strict    │ │ "Deep      │
 │  helper"   │ │  Chinese"  │ │  reviewer" │ │  research" │
 └────────────┘ └────────────┘ └────────────┘ └────────────┘
   PID 4821       PID 5102       PID 5340       PID 5520
```

### Deploy in 30 Seconds

```bash
# Configure each instance
npm run dev -- telegram configure <token-A>
npm run dev -- telegram configure --instance work <token-B>
npm run dev -- telegram configure --instance reviewer <token-C>

# Set engines
npm run dev -- telegram engine claude --instance reviewer

# Set personalities
npm run dev -- telegram instructions set --instance reviewer ./reviewer-instructions.md

# Enable YOLO for mobile use
npm run dev -- telegram yolo on --instance work

# Start them all
npm run dev -- telegram service start
npm run dev -- telegram service start --instance work
npm run dev -- telegram service start --instance reviewer
```

---

## Agent Instructions

Each bot has its own `agent.md`. Hot-reloaded on every message — edit anytime, no restart needed.

```powershell
npm run dev -- telegram instructions show --instance work
npm run dev -- telegram instructions set --instance work ./my-instructions.md
npm run dev -- telegram instructions path --instance work
```

Or edit directly:

```powershell
# Windows
notepad %USERPROFILE%\.codex\channels\telegram\work\agent.md

# macOS
open -e ~/.codex/channels/telegram/work/agent.md
```

---

## YOLO Mode

```powershell
npm run dev -- telegram yolo on --instance work      # Safe auto-approve
npm run dev -- telegram yolo unsafe --instance work   # Skip ALL checks
npm run dev -- telegram yolo off --instance work      # Normal flow
npm run dev -- telegram yolo --instance work          # Check status
```

| Mode | Codex | Claude | Use case |
|---|---|---|---|
| `off` | Normal approvals | Normal approvals | Default, safest |
| `on` | `--full-auto` | `--permission-mode bypassPermissions` | Mobile use |
| `unsafe` | `--dangerously-bypass-*` | `--dangerously-skip-permissions` | Trusted env only |

---

## Quick Start

### Prerequisites

- **Node.js** >= 20
- **OpenAI Codex CLI** and/or **Claude Code CLI** installed and authenticated
- A **Telegram Bot Token** from [@BotFather](https://t.me/BotFather)

### Install

```bash
git clone https://github.com/cloveric/cc-telegram-bridge.git
cd cc-telegram-bridge
npm install
npm run build
```

### Single Bot (Simplest)

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

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        cc-telegram-bridge                       │
├─────────────┬──────────────┬──────────────────┬─────────────────────┤
│  Telegram   │   Runtime    │     AI Engine    │      State          │
│  Layer      │   Layer      │     Layer        │      Layer          │
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

**Data flow:**

```
Telegram Update → Normalize → Access Check → Chat Queue (serialized)
    → Load config.json (engine) → Load agent.md → Session Lookup
    → Codex Exec or Claude -p (new or resume) → Render → Deliver → Audit
```

---

## Highlights

<table>
  <tr>
    <td width="50%">
      <h3>Dual Engine</h3>
      <p>Switch between Codex and Claude Code per instance. Mix and match — one bot on Codex, another on Claude, managed from one CLI.</p>
    </td>
    <td width="50%">
      <h3>Per-Bot Personality</h3>
      <p>Each instance loads its own <code>agent.md</code> on every message. Claude instances also get <code>CLAUDE.md</code> project rules.</p>
    </td>
  </tr>
  <tr>
    <td>
      <h3>YOLO Mode</h3>
      <p>One command to auto-approve everything — works with both engines. Per-instance, hot-reloadable.</p>
    </td>
    <td>
      <h3>Instance Isolation</h3>
      <p>Every instance: own engine, token, access, sessions, threads, inbox, audit trail. No shared state.</p>
    </td>
  </tr>
  <tr>
    <td>
      <h3>Production Resilience</h3>
      <p>Long polling (~0ms latency), exponential backoff, 429 auto-retry, graceful SIGTERM/SIGINT shutdown, fault-tolerant batch processing.</p>
    </td>
    <td>
      <h3>Full Audit Trail</h3>
      <p>Every action recorded per-instance in append-only JSONL — including engine switches and YOLO toggles.</p>
    </td>
  </tr>
</table>

---

## Service Operations

| Command | Description |
|---|---|
| `telegram service start` | Acquire lock, load state, begin long-polling |
| `telegram service stop` | Graceful shutdown (SIGTERM/SIGINT) |
| `telegram service status` | Running state, PID, engine, bot identity, audit health |
| `telegram service restart` | Stop + start with clean consumer reset |
| `telegram service logs` | Tail stdout/stderr logs |
| `telegram service doctor` | Health check across all subsystems |
| `telegram engine [codex\|claude]` | Switch AI engine per instance |
| `telegram yolo [on\|off\|unsafe]` | Toggle auto-approval mode |
| `telegram help` | Show all available commands |

All commands accept `--instance <name>` to target a specific bot.

### Shell Helpers

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

## Access Control

Per-instance, two layers: **pairing** + **allowlist**.

```bash
npm run dev -- telegram access pair <code>
npm run dev -- telegram access policy allowlist
npm run dev -- telegram access allow <chat-id>
npm run dev -- telegram access revoke <chat-id>
npm run dev -- telegram status [--instance work]
```

---

## State Layout

```
# Windows: %USERPROFILE%\.codex\channels\telegram\<instance>\
# macOS/Linux: ~/.codex/channels/telegram/<instance>/

<instance>/
├── agent.md                # Bot personality & instructions
├── config.json             # Engine (codex|claude), YOLO mode
├── workspace/              # Claude working directory (Claude engine only)
│   └── CLAUDE.md           # Claude Code project instructions
├── .env                    # Bot token
├── access.json             # Pairing + allowlist data
├── session.json            # Chat-to-thread bindings
├── runtime-state.json      # Watermarks, offsets
├── instance.lock.json      # Process lock
├── audit.log.jsonl         # Structured audit stream
├── service.stdout.log      # Service stdout
├── service.stderr.log      # Service stderr
└── inbox\                  # Downloaded attachments
```

---

## Development

```bash
npm run dev -- <command>     # Development mode
npm test                     # Run tests
npm run test:watch           # Watch mode
npm run build                # Build for production
npm start                    # Start production build
```

---

## Troubleshooting

<details>
<summary><strong>Bot does not reply</strong></summary>

1. Run `telegram service doctor` to diagnose
2. Check `telegram service logs` for errors
3. Verify the engine is installed: `codex --version` or `claude --version`

</details>

<details>
<summary><strong>Switching to Claude engine</strong></summary>

1. `telegram engine claude --instance <name>`
2. Restart the service: `telegram service restart --instance <name>`
3. Optionally add a `CLAUDE.md` in the workspace directory

</details>

<details>
<summary><strong>agent.md changes not taking effect</strong></summary>

No restart needed — loaded fresh on every message. Verify path with `telegram instructions path --instance <name>`.

</details>

---

## License

[MIT](./LICENSE)

---

<p align="center">
  <sub>Your agents. Your engines. Your rules.</sub>
</p>
