<p align="center">
  <img src="./assets/github-banner.svg" alt="Codex Telegram Channel banner" width="100%" />
</p>

<p align="center">
  <strong>Run Codex through Telegram with isolated bot instances, resumable threads, attachment ingestion, and operator-friendly controls.</strong>
</p>

<p align="center">
  <a href="https://github.com/cloveric/codex-telegram-channel">Repository</a>
  ·
  <a href="#quick-start">Quick Start</a>
  ·
  <a href="#service-operations">Service Operations</a>
  ·
  <a href="#access-control">Access Control</a>
</p>

## Overview

`codex-telegram-channel` is a Windows-first Telegram bridge for Codex. It treats each bot as a distinct runtime instance with its own token, state, lock, logs, inbox, update watermark, and chat-to-thread bindings.

This is not a multiplexed “one process hosts many bots” design. The operating model is simple:

- one bot token per instance
- one instance per running process
- one Telegram chat bound to one persisted Codex thread

## Core Capabilities

- Instance-scoped bot tokens and state directories
- Pairing and allowlist access control
- Service lifecycle commands: start, stop, status
- Per-chat serialized execution
- Attachment download into the instance inbox
- Placeholder message plus edited final response
- Resumable Codex threads using `codex exec --json` and `codex exec resume --json`
- Local duplicate-instance protection with an instance lock
- Update de-duplication and persisted runtime state

## Quick Start

Install and build:

```powershell
git clone https://github.com/cloveric/codex-telegram-channel.git
cd codex-telegram-channel
npm install
npm run build
```

Configure the default bot instance:

```powershell
npm run dev -- telegram configure <bot-token>
```

Configure a named instance:

```powershell
npm run dev -- telegram configure --instance work <bot-token>
```

Recommended operator flow:

1. Configure an instance token
2. Start the instance service
3. Pair your private chat
4. Switch policy to `allowlist` if you want only approved chats to continue
5. Use `telegram service status` to verify the process, PID, bot identity, and last handled update

## Service Operations

Start the default instance:

```powershell
npm run dev -- telegram service start
```

Start a named instance:

```powershell
npm run dev -- telegram service start --instance work
```

Check service status:

```powershell
npm run dev -- telegram service status
npm run dev -- telegram service status --instance work
```

Stop an instance:

```powershell
npm run dev -- telegram service stop
npm run dev -- telegram service stop --instance work
```

PowerShell helpers are also included:

```powershell
.\scripts\start-instance.ps1
.\scripts\status-instance.ps1
.\scripts\stop-instance.ps1
```

Named instance:

```powershell
.\scripts\start-instance.ps1 -Instance work
.\scripts\status-instance.ps1 -Instance work
.\scripts\stop-instance.ps1 -Instance work
```

Pre-complete verification hook:

```powershell
.\scripts\pre-complete-hook.ps1
```

This runs the full test suite and build before treating a milestone as complete.

`telegram service status` reports:

- whether the instance is running
- PID
- access policy
- paired user count
- allowlist count
- pending pair count
- last handled Telegram update id
- bot identity when token lookup succeeds

## Access Control

Redeem a pairing code:

```powershell
npm run dev -- telegram access pair <code>
```

Set policy:

```powershell
npm run dev -- telegram access policy allowlist
```

Allow or revoke a chat:

```powershell
npm run dev -- telegram access allow <chat-id>
npm run dev -- telegram access revoke <chat-id>
```

View current access status:

```powershell
npm run dev -- telegram status
```

## Troubleshooting

If the bot replies more than once:

- run `npm run dev -- telegram service status`
- make sure only one instance is running for that instance name
- use `npm run dev -- telegram service restart` to reset the local consumer cleanly

If the bot does not reply at all:

- run `npm run dev -- telegram service logs`
- confirm `Bot token configured: yes`
- confirm `Running: yes`

If `service status` says the instance is not running:

- run `npm run dev -- telegram service start`
- if it still fails, inspect the reported stderr log path

If you changed bot tokens:

- rerun `telegram configure`
- then restart the instance service

## State Layout

Each instance stores state under:

```text
%USERPROFILE%\.codex\channels\telegram\<instance>\
```

Per-instance files:

- `.env`
- `access.json`
- `session.json`
- `runtime-state.json`
- `instance.lock.json`
- `service.stdout.log`
- `service.stderr.log`
- `inbox\`

## Repository Layout

- `src/`: bridge, state, runtime, Telegram, and Codex integration
- `tests/`: Vitest suites
- `site/`: static presentation assets
- `assets/`: repository visual assets

## Scripts

- `npm run build`
- `npm run dev`
- `npm start`
- `npm test`
- `npm run test:watch`
