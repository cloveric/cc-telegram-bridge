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

<p align="center">
  <strong>Run OpenAI Codex through Telegram with isolated bot instances, resumable threads, and operator-grade controls.</strong>
</p>

<p align="center">
  <a href="#-quick-start">Quick Start</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#-architecture">Architecture</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#-service-operations">Service Ops</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#-access-control">Access Control</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#-troubleshooting">Troubleshooting</a>
</p>

---

## Why This Exists

Running Codex from your phone should feel like operating a private field console — not babysitting a fragile script. **Codex Telegram Channel** turns each Telegram bot into an isolated Codex runtime with its own state, access model, and thread bindings.

This is **not** a multiplexed "one process hosts many bots" design. The operating model is deliberately simple:

| Principle | What it means |
|---|---|
| **One bot token per instance** | Each instance owns its token, state directory, and lock file |
| **One instance per process** | No shared mutable state between bots |
| **One chat per Codex thread** | Messages resume the exact same thread — no cold starts |

---

## Highlights

<table>
  <tr>
    <td width="50%">
      <h3>Instance Isolation</h3>
      <p>Every instance keeps its own token, access model, lock, inbox, logs, update watermark, and Codex threads. Run three bots? Three isolated processes.</p>
    </td>
    <td width="50%">
      <h3>Access Control</h3>
      <p>Pairing codes + allowlist policy gate execution <em>before</em> Codex work or attachment downloads are permitted. No anonymous access by default.</p>
    </td>
  </tr>
  <tr>
    <td>
      <h3>Resumable Threads</h3>
      <p>The first message creates a Codex thread; subsequent messages <code>resume</code> it. Context carries across sessions via <code>codex exec resume --json</code>.</p>
    </td>
    <td>
      <h3>Service Lifecycle</h3>
      <p>Start, stop, status, and restart commands with PID tracking, stderr logs, and bot identity verification built in.</p>
    </td>
  </tr>
  <tr>
    <td>
      <h3>Attachment Ingestion</h3>
      <p>Files sent to the bot are downloaded into a per-instance <code>inbox/</code> directory and made available to the Codex session automatically.</p>
    </td>
    <td>
      <h3>Update Deduplication</h3>
      <p>Persisted watermarks and offset tracking ensure no message is processed twice, even across restarts.</p>
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

### Configure & Launch

```powershell
# Configure the default instance
npm run dev -- telegram configure <your-bot-token>

# Start the service
npm run dev -- telegram service start

# Check status
npm run dev -- telegram service status
```

### Named Instances

Run multiple bots by specifying `--instance`:

```powershell
npm run dev -- telegram configure --instance work <token>
npm run dev -- telegram service start --instance work
npm run dev -- telegram service status --instance work
```

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
│ message-    │              │                  │                     │
│ renderer.ts │              │                  │                     │
└─────────────┴──────────────┴──────────────────┴─────────────────────┘
```

**Data flow:**

```
Telegram Update → Normalize → Access Check → Chat Queue (serialized)
    → Session Lookup → Codex Exec (new or resume) → Render → Deliver
```

Each layer is independently testable. The bridge orchestrates the flow without owning any state directly.

---

## Service Operations

| Command | Description |
|---|---|
| `telegram service start` | Acquire lock, load state, begin polling |
| `telegram service stop` | Graceful shutdown with state persistence |
| `telegram service status` | Running state, PID, policy, bot identity, last update ID |
| `telegram service restart` | Stop + start with clean consumer reset |

### Status Output

```
Running:       yes
PID:           4821
Policy:        allowlist
Paired users:  2
Allowlist:     2
Pending pairs: 0
Last update:   948271653
Bot identity:  @cloveric6bot
```

### PowerShell Helpers

```powershell
.\scripts\start-instance.ps1 [-Instance work]
.\scripts\status-instance.ps1 [-Instance work]
.\scripts\stop-instance.ps1 [-Instance work]
```

---

## Access Control

Access is gated in two layers: **pairing** (initial handshake) and **policy** (ongoing authorization).

```powershell
# Generate and redeem a pairing code
npm run dev -- telegram access pair <code>

# Switch to allowlist-only mode
npm run dev -- telegram access policy allowlist

# Manage the allowlist
npm run dev -- telegram access allow <chat-id>
npm run dev -- telegram access revoke <chat-id>

# View current access state
npm run dev -- telegram status
```

### Recommended Operator Flow

1. Configure an instance token
2. Start the instance service
3. Pair your private chat with the generated code
4. Switch policy to `allowlist` to lock down access
5. Use `service status` to verify everything is running

---

## State Layout

Each instance persists state under a dedicated directory:

```
%USERPROFILE%\.codex\channels\telegram\<instance>\
├── .env                    # Bot token
├── access.json             # Pairing + allowlist data
├── session.json            # Chat-to-thread bindings
├── runtime-state.json      # Watermarks, offsets
├── instance.lock.json      # Process lock
├── service.stdout.log      # Service stdout
├── service.stderr.log      # Service stderr
└── inbox\                  # Downloaded attachments
```

---

## Project Structure

```
codex-telegram-channel/
├── src/
│   ├── index.ts              # Entry point
│   ├── config.ts             # Configuration
│   ├── instance.ts           # Instance definition
│   ├── service.ts            # Service lifecycle
│   ├── types.ts              # Shared types
│   ├── codex/                # Codex integration
│   ├── commands/             # CLI commands
│   ├── runtime/              # Bridge, queue, sessions
│   ├── state/                # Persistence layer
│   └── telegram/             # Telegram API wrapper
├── tests/                    # Vitest test suites
├── scripts/                  # PowerShell helpers
├── site/                     # Static landing page
└── assets/                   # Visual assets
```

---

## Development

```powershell
# Run in development mode
npm run dev -- <command>

# Run tests
npm test

# Watch mode
npm run test:watch

# Build for production
npm run build

# Start production build
npm start
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

1. Run `telegram service logs`
2. Confirm `Bot token configured: yes`
3. Confirm `Running: yes`

</details>

<details>
<summary><strong>Service won't start</strong></summary>

1. Check if another instance holds the lock
2. Inspect the stderr log path reported by `service status`
3. If you changed bot tokens, rerun `telegram configure` then restart

</details>

---

## License

[MIT](./LICENSE)

---

<p align="center">
  <sub>Built with purpose. Operated with control.</sub>
</p>
