<p align="center">
  <img src="./assets/github-banner.svg" alt="Codex Telegram Channel" width="100%" />
</p>

<p align="center">
  <a href="https://github.com/cloveric/codex-telegram-channel/blob/main/LICENSE"><img src="https://img.shields.io/github/license/cloveric/codex-telegram-channel?style=flat-square&color=818cf8" alt="License"></a>
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178c6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D20-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js">
  <img src="https://img.shields.io/badge/platform-Windows-0078D4?style=flat-square&logo=windows&logoColor=white" alt="Windows">
  <img src="https://img.shields.io/badge/tests-Vitest-6E9F18?style=flat-square&logo=vitest&logoColor=white" alt="Vitest">
  <img src="https://img.shields.io/badge/validation-Zod_4-3E67B1?style=flat-square&logo=zod&logoColor=white" alt="Zod">
</p>

<h3 align="center">
  Run a fleet of personality-customizable Codex agents on Telegram.<br>
  Each bot gets its own <code>agent.md</code>, state, threads, and access control.<br>
  <sub>Think <a href="https://github.com/openclaw">OpenClaw</a>, but for Codex over Telegram.</sub>
</h3>

<p align="center">
  <a href="#-multi-bot-setup">Multi-Bot</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#-agent-instructions">agent.md</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#-quick-start">Quick Start</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#-architecture">Architecture</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#-service-operations">Service Ops</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#-access-control">Access Control</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#-audit-trail">Audit</a>
</p>

---

## Multi-Bot Setup

Run as many Codex bots as you need. Each instance is fully isolated — its own token, personality, threads, access rules, inbox, and audit trail. No shared state, no interference.

```
                  ┌──────────────────────────────┐
                  │   codex-telegram-channel      │
                  └──────────┬───────────────────┘
          ┌─────────────────┼──────────────────┐
          ▼                 ▼                   ▼
   ┌─────────────┐  ┌─────────────┐  ┌──────────────┐
   │  "default"  │  │   "work"    │  │  "personal"  │
   │  @mybot     │  │  @work_bot  │  │  @helper_bot │
   │             │  │             │  │              │
   │ agent.md:   │  │ agent.md:   │  │ agent.md:    │
   │ "General    │  │ "Senior     │  │ "Reply in    │
   │  assistant" │  │  reviewer"  │  │  Chinese"    │
   │             │  │             │  │              │
   │ policy:     │  │ policy:     │  │ policy:      │
   │  pairing    │  │  allowlist  │  │  pairing     │
   └─────────────┘  └─────────────┘  └──────────────┘
     PID 4821         PID 5102         PID 5340
```

### Deploy Multiple Bots in 30 Seconds

```powershell
# Create three bots from @BotFather, then:

# 1. Configure each instance with its own token
npm run dev -- telegram configure <token-A>
npm run dev -- telegram configure --instance work <token-B>
npm run dev -- telegram configure --instance personal <token-C>

# 2. Start them all (each runs as its own process)
npm run dev -- telegram service start
npm run dev -- telegram service start --instance work
npm run dev -- telegram service start --instance personal

# 3. Check fleet status
npm run dev -- telegram service status
npm run dev -- telegram service status --instance work
npm run dev -- telegram service status --instance personal
```

Each instance stores state independently:

```
%USERPROFILE%\.codex\channels\telegram\
├── default\          ← @mybot
│   ├── agent.md      ← personality & instructions
│   ├── .env          ← bot token
│   ├── access.json
│   ├── session.json
│   ├── audit.log.jsonl
│   └── inbox\
├── work\             ← @work_bot
│   ├── agent.md
│   ├── .env
│   └── ...
└── personal\         ← @helper_bot
    ├── agent.md
    ├── .env
    └── ...
```

---

## Agent Instructions

The killer feature: **each bot can have its own personality and behavior** defined in an `agent.md` file.

The `agent.md` is prepended to every Codex prompt. It's loaded fresh on every message, so you can edit it without restarting the service.

### Examples

**Work bot** — code reviewer:

```markdown
# agent.md for "work" instance

You are a senior code reviewer. Focus on:
- Correctness and edge cases
- Security vulnerabilities
- Performance implications
- Naming and readability

Be direct. Flag issues by severity. Don't sugarcoat.
```

**Personal bot** — friendly assistant:

```markdown
# agent.md for "personal" instance

You are a friendly coding assistant. Reply in Chinese.
Keep answers concise. Use code examples when helpful.
When unsure, say so — don't guess.
```

**Research bot** — exploration mode:

```markdown
# agent.md for "research" instance

You are a research assistant. When given a topic:
1. Explore the problem space thoroughly
2. List tradeoffs between approaches
3. Provide citations and references
4. Suggest next steps

Think step by step. Prefer depth over breadth.
```

### CLI Commands

```powershell
# See where the agent.md lives
npm run dev -- telegram instructions path --instance work

# Import instructions from a file
npm run dev -- telegram instructions set --instance work ./work-instructions.md

# View current instructions
npm run dev -- telegram instructions show --instance work
```

Or just edit the file directly:

```powershell
notepad %USERPROFILE%\.codex\channels\telegram\work\agent.md
```

---

## Why This Design

This is **not** a multiplexed "one process hosts many bots" design. The operating model is deliberately simple:

| Principle | What it means |
|---|---|
| **One bot token per instance** | Each instance owns its token, state directory, and lock file |
| **One instance per process** | No shared mutable state between bots |
| **One chat per Codex thread** | Messages resume the exact same thread — no cold starts |
| **One agent.md per bot** | Each bot has its own personality, role, and behavior rules |

The OpenClaw-style experience: you create multiple specialized bots, each with distinct instructions and access policies, and manage them as a fleet from one CLI.

---

## Highlights

<table>
  <tr>
    <td width="50%">
      <h3>Per-Bot Personality</h3>
      <p>Each instance loads its own <code>agent.md</code> on every message. Change the file, the behavior changes immediately. No restart needed.</p>
    </td>
    <td width="50%">
      <h3>Instance Isolation</h3>
      <p>Every instance keeps its own token, access model, lock, inbox, logs, update watermark, and Codex threads. Run three bots? Three isolated processes.</p>
    </td>
  </tr>
  <tr>
    <td>
      <h3>Resumable Threads</h3>
      <p>The first message creates a Codex thread; subsequent messages <code>resume</code> it. Context carries across sessions via <code>codex exec resume --json</code>.</p>
    </td>
    <td>
      <h3>Access Control</h3>
      <p>Pairing codes + allowlist policy gate execution <em>before</em> Codex work or attachment downloads are permitted. Per-bot access rules.</p>
    </td>
  </tr>
  <tr>
    <td>
      <h3>Full Audit Trail</h3>
      <p>Every action (pairing, messages, errors, access changes) is recorded in a per-instance append-only JSONL audit stream with timing metadata.</p>
    </td>
    <td>
      <h3>Service Lifecycle</h3>
      <p>Start, stop, status, restart, logs, and doctor commands with PID tracking, stderr logs, and bot identity verification.</p>
    </td>
  </tr>
</table>

---

## Quick Start

### Prerequisites

- **Node.js** >= 20
- **OpenAI Codex CLI** installed and authenticated
- A **Telegram Bot Token** from [@BotFather](https://t.me/BotFather)

### Install

```powershell
git clone https://github.com/cloveric/codex-telegram-channel.git
cd codex-telegram-channel
npm install
npm run build
```

### Single Bot (Simplest)

```powershell
npm run dev -- telegram configure <your-bot-token>
npm run dev -- telegram service start
npm run dev -- telegram service status
```

### Operator Flow

1. Configure instance token(s)
2. Write `agent.md` for each bot's personality
3. Start instance service(s)
4. Pair your private chat with the generated code
5. Switch policy to `allowlist` to lock down access
6. Use `service status` and `service doctor` to monitor

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        codex-telegram-channel                       │
├─────────────┬──────────────┬──────────────────┬─────────────────────┤
│  Telegram   │   Runtime    │     Codex        │      State          │
│  Layer      │   Layer      │     Layer        │      Layer          │
├─────────────┼──────────────┼──────────────────┼─────────────────────┤
│ api.ts      │ bridge.ts    │ adapter.ts       │ access-store.ts     │
│ delivery.ts │ chat-queue.ts│ process-adapter  │ session-store.ts    │
│ update-     │ session-     │   .ts            │ runtime-state.ts    │
│ normalizer  │ manager.ts   │                  │ instance-lock.ts    │
│   .ts       │              │                  │ json-store.ts       │
│ message-    │              │  agent.md ──►    │ audit-log.ts        │
│ renderer.ts │              │  prompt prepend  │                     │
└─────────────┴──────────────┴──────────────────┴─────────────────────┘
```

**Data flow:**

```
Telegram Update → Normalize → Access Check → Chat Queue (serialized)
    → Load agent.md → Session Lookup → Codex Exec (new or resume)
    → Render → Deliver → Audit
```

---

## Service Operations

| Command | Description |
|---|---|
| `telegram service start` | Acquire lock, load state, begin polling |
| `telegram service stop` | Graceful shutdown with state persistence |
| `telegram service status` | Running state, PID, session bindings, bot identity, audit health |
| `telegram service restart` | Stop + start with clean consumer reset |
| `telegram service logs` | Tail stdout/stderr logs |
| `telegram service doctor` | Health check: build, token, runtime, identity, sessions, audit |

All commands accept `--instance <name>` to target a specific bot.

### PowerShell Helpers

```powershell
.\scripts\start-instance.ps1 [-Instance work]
.\scripts\status-instance.ps1 [-Instance work]
.\scripts\stop-instance.ps1 [-Instance work]
```

---

## Access Control

Access is gated per-instance in two layers: **pairing** (initial handshake) and **policy** (ongoing authorization).

```powershell
npm run dev -- telegram access pair <code>
npm run dev -- telegram access policy allowlist
npm run dev -- telegram access allow <chat-id>
npm run dev -- telegram access revoke <chat-id>
npm run dev -- telegram status [--instance work]
```

---

## Session Visibility

```powershell
npm run dev -- telegram session list [--instance work]
npm run dev -- telegram session show [--instance work] <chat-id>
```

---

## Audit Trail

Each instance writes an append-only JSONL audit stream:

```powershell
npm run dev -- telegram audit [--instance work]
npm run dev -- telegram audit 50
npm run dev -- telegram audit --type update.handle --outcome error
npm run dev -- telegram audit --chat 688567588
```

---

## State Layout

```
%USERPROFILE%\.codex\channels\telegram\<instance>\
├── agent.md                # Bot personality & instructions
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

```powershell
npm run dev -- <command>     # Development mode
npm test                     # Run tests
npm run test:watch           # Watch mode
npm run build                # Build for production
npm start                    # Start production build
```

---

## Troubleshooting

<details>
<summary><strong>Bot replies more than once</strong></summary>

1. Run `telegram service status` — ensure only one instance is running for that name
2. Use `telegram service restart` to reset the consumer cleanly

</details>

<details>
<summary><strong>Bot does not reply at all</strong></summary>

1. Run `telegram service doctor` to diagnose
2. Check `telegram service logs` for errors
3. Confirm `Bot token configured: yes` in status

</details>

<details>
<summary><strong>agent.md changes not taking effect</strong></summary>

No restart needed — `agent.md` is loaded fresh on every message. Verify the file path with `telegram instructions path --instance <name>` and check the content with `telegram instructions show`.

</details>

<details>
<summary><strong>Service won't start</strong></summary>

1. Check if another instance holds the lock
2. Run `telegram service doctor` for detailed health checks
3. If you changed bot tokens, rerun `telegram configure` then restart

</details>

---

## License

[MIT](./LICENSE)

---

<p align="center">
  <sub>Your Codex. Your bots. Your rules.</sub>
</p>
