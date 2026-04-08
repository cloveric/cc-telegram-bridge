# codex-telegram-channel

Instance-aware Telegram bridge for Codex on Windows.

Each running instance owns exactly one Telegram bot token, one isolated state directory, and one set of Codex chat bindings. If you want three bots, run three instances.

## Current Behavior

- One bot instance per process
- Pairing and allowlist access control
- Telegram polling with retry-safe offset handling
- Per-chat serialized execution
- Placeholder message followed by edited final response
- Attachment download into the instance inbox
- Codex thread persistence using `codex exec --json` for the first real message and `codex exec resume --json` afterward

## State Layout

Default root:

```text
%USERPROFILE%\.codex\channels\telegram\<instance>\
```

Per-instance files:

- `.env`
- `access.json`
- `session.json`
- `runtime.log`
- `inbox\`

## Install

```powershell
cd C:\Users\hangw\codex-telegram-channel
npm install
npm run build
```

## Configure A Bot

Default instance:

```powershell
npm run dev -- telegram configure <bot-token>
```

Named instance:

```powershell
npm run dev -- telegram configure --instance work <bot-token>
```

## Access Management

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

Check instance status:

```powershell
npm run dev -- telegram status
npm run dev -- telegram status --instance work
```

## Run An Instance

Default instance:

```powershell
npm start
```

Named instance:

```powershell
node dist/index.js --instance work
```

The service will:

- load the bot token from the instance `.env`
- poll Telegram updates
- enforce pairing or allowlist rules
- bind each Telegram chat to a persisted Codex thread

## Scripts

- `npm run build` compiles TypeScript to `dist/`
- `npm run dev` runs the entrypoint with `tsx`
- `npm start` runs the compiled app
- `npm test` runs Vitest once
- `npm run test:watch` runs Vitest in watch mode
