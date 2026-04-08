# CC Telegram Bridge Instructions

## Mission

This repository is not in maintenance mode. The active objective is:

`recreate Claude Code's Telegram plugin behavior as closely as practical for Codex, and keep improving until parity or better operational stability is reached`

Do not treat "feature implemented" as "work complete" unless the current milestone has been verified end-to-end.

## Persistence Rule

When you feel the urge to stop, summarize, or hand back partially-finished work:

1. Run `.\scripts\pre-complete-hook.ps1`
2. If it fails, fix the failures
3. If it passes but known parity/stability gaps remain, continue with the highest-value next task
4. Only stop when:
   - the current milestone is actually complete, or
   - you hit a real blocker that cannot be resolved locally

Do not stop just because:

- tests are passing
- one bug is fixed
- one feature was merged
- a bot replied once

This project should be driven toward:

- stronger service stability
- tighter access control
- better session continuity
- cleaner operator experience
- closer Claude-plugin parity

## Verification Standard

Before claiming meaningful progress, prefer evidence over assertion:

- `npm test`
- `npm run build`
- focused runtime checks for the area touched

## Operator Priorities

When choosing the next task without asking:

1. Fix correctness or security bugs
2. Fix duplicate replies, dropped updates, broken service lifecycle, or bad session continuity
3. Improve operator controls and observability
4. Improve GitHub presentation and documentation

## Repo Notes

- Windows-first project
- One Telegram bot per instance
- One instance per process
- State lives under `%USERPROFILE%\.codex\channels\telegram\<instance>\`
