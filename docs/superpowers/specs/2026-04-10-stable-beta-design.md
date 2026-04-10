# Stable Beta Productization Design

## Goal

Turn the current Telegram bridge from a capable internal tool into a stable beta that can support a small number of real users without frequent operator rescue.

The target is not a full product platform. The target is a reliable, operable, Telegram-first tool that can run for days, recover from common failure modes, and expose enough controls that the operator does not need to hand-edit state files during normal use.

## Scope

This design covers three phases:

1. Reliability hardening
2. Operator and maintenance tooling
3. Telegram interaction improvements

This design explicitly does not include:

- A web admin dashboard
- Multi-tenant account management
- A full Telegram file browser or project browser
- A large runtime refactor
- A full unification of Claude and Codex internals

## Current Product Position

The bridge already has the core shape of a usable product:

- Multiple Telegram instances
- Codex and Claude engine support
- Pairing and allowlist access control
- Audit logging
- Session binding
- File upload workflows
- Service lifecycle commands

The current gap is not basic capability. The gap is product reliability and product operations:

- failures still require too much manual inspection
- session and task state can become stale or polluted
- engine behavior is not consistently normalized into product-facing outcomes
- operator tooling is thin
- Telegram UX is serviceable but not polished

## Product Target

The stable beta milestone means:

- 2-5 users can use the bridge continuously
- common failures are diagnosable in minutes
- broken chat sessions can be reset without touching JSON files manually
- file workflows behave consistently enough that users can trust them
- Telegram interactions are clear enough that the bridge feels like a product, not a raw transport

## Architecture Direction

The current runtime core should remain intact. Productization should happen by hardening the core and adding controlled layers around it.

### Core Layer

Keep the existing `adapter`, `bridge`, `delivery`, and `state` structure as the main execution path.

Allowed changes in this layer:

- reliability fixes
- normalization of engine behavior into bridge behavior
- task state cleanup
- better error taxonomy

Avoid in this layer:

- wholesale file moves
- broad runtime redesign
- speculative abstraction work

### Operator Layer

Add operator-oriented commands and summaries on top of existing state and service commands.

This layer should provide:

- health inspection
- session inspection and reset
- task inspection and cleanup
- quick diagnostic summaries
- safer restarts

### Telegram UX Layer

Improve the user-facing experience in Telegram without creating a heavy interactive control panel.

This layer should provide:

- clear commands
- clear task state messages
- small, high-value shortcut buttons
- recovery-oriented failure messages

## Phase 1: Reliability Hardening

Phase 1 is the highest priority. The bridge should become difficult to wedge and easy to recover.

### 1. Session Governance

Add explicit support for managing chat-to-engine session bindings.

Requirements:

- a chat session can be inspected
- a chat session can be reset
- a stale or polluted session can be cleared without touching unrelated access state
- session reset should not revoke pairing or allowlist access

Design intent:

- session binding is an operational object, not a hidden implementation detail
- stale sessions should be recoverable by command

### 2. Failure Taxonomy

Errors must be classified into product-facing categories instead of returning vague generic failures.

Minimum categories:

- authentication failure
- write permission or sandbox failure
- Telegram transport conflict or delivery failure
- engine CLI failure
- file ingestion or file extraction failure
- session state failure

Requirements:

- user-facing messages should map to these categories
- audit entries should record the category
- operator tooling should surface recent categorized failures

### 3. Unified File Return Strategy

File return behavior must be normalized across engines as a product rule, not left to model improvisation.

Rules:

- small text and code files should prefer inline ````file:...``` `` blocks
- disk-backed output directories are a fallback for larger or non-inline outputs
- product logic, not model guesswork, decides the preferred path

Implications:

- Codex and Claude may still use different runtime instructions internally
- the product contract exposed to users should be consistent

### 4. Task State Hardening

Long-running and deferred tasks must have explicit status.

Task states should clearly represent:

- processing
- awaiting user continuation
- completed
- failed

Requirements:

- state should survive service restart
- stale tasks should not silently block later work
- operator tooling should show unresolved tasks

### 5. Retry and Duplicate Boundaries

The bridge must keep duplicate update handling and retry behavior predictable.

Requirements:

- the same Telegram update is not processed multiple times
- failed processing should not spam repeated user-visible messages
- restart behavior should not resurrect already completed updates
- progress updates should not overwrite terminal answers

### 6. Diagnostics That Operators Can Read

The system should expose enough state that the operator can answer basic questions quickly:

- is the instance alive
- what was the last success
- what was the last failure
- why did it fail
- does this chat have a session binding
- are there unresolved file tasks

### Phase 1 Completion Criteria

Phase 1 is complete when:

- the operator can identify the cause of a failure quickly
- the operator can clear a bad session without manual JSON edits
- file send and file upload flows are consistent enough to trust
- restarts do not obviously corrupt state or duplicate work
- a few users can run the bridge for days without frequent manual repair

## Phase 2: Operator and Maintenance Tooling

Phase 2 should extend the existing CLI rather than add a web panel.

Rationale:

- fastest path to real operational value
- lowest implementation risk
- least architectural overhead
- most compatible with current service model

### 1. Instance Doctor

Add a health summary command for an instance.

Suggested command:

`service doctor --instance <name>`

The doctor summary should include:

- running state
- PID
- engine type
- runtime type
- latest success
- latest failure
- latest failure category
- bot token presence
- session binding count
- unresolved task count

### 2. Session Inspection and Reset

Add commands to inspect and clear chat session state.

Suggested commands:

- `session list --instance <name>`
- `session inspect --instance <name> --chat <chatId>`
- `session reset --instance <name> --chat <chatId>`

Behavior:

- session reset should clear only the selected chat session binding
- access policy and pairing state remain unchanged

### 3. Task Inspection and Cleanup

Add commands to inspect and clear file workflow tasks.

Suggested commands:

- `task list --instance <name>`
- `task inspect --instance <name> --upload <uploadId>`
- `task clear --instance <name> --upload <uploadId>`

The operator should be able to see:

- recent uploads
- current status
- source files
- extracted directory, if any
- failure state, if any

### 4. Quick Diagnostic Logs

Add a concise event-oriented log view in addition to raw stdout/stderr tails.

The quick view should summarize:

- recent updates
- recent failures
- recent file return events
- recent Telegram conflicts

### 5. Safer Restart Flow

Restart behavior should explain state relevant to recovery.

Before or after restart, the operator should be able to see:

- whether a prior lock existed
- whether session bindings remain
- whether unresolved tasks remain

### Phase 2 Completion Criteria

Phase 2 is complete when normal recovery does not require manual file edits and the operator can manage instances through supported commands alone.

## Phase 3: Telegram Interaction Improvements

Phase 3 should improve clarity and usability without creating a large Telegram state machine.

### 1. Clear Command Surface

Add a small set of user-facing commands:

- `/status`
- `/reset`
- `/tasks`
- `/continue`
- `/help`

These commands should map to existing bridge concepts and not create parallel logic.

### 2. Better Long-Task Messaging

User-visible task progress should be explicit about the phase:

- downloading attachments
- extracting archive
- calling engine
- returning file
- waiting for follow-up user action

### 3. Unified File Task Messaging

File flows should tell the user exactly what to do next.

Examples:

- after archive summary, instruct the user to reply with `/continue` or `继续分析`
- after file send success, state what was delivered
- after a failure, explain whether it was caused by file size, permissions, Telegram delivery, or engine behavior

### 4. Small Shortcut Buttons

Only add a few high-value shortcuts:

- continue analysis
- reset session
- show status

Do not build nested menus or project browsers in this milestone.

### 5. Better Help Copy

Help content should explain:

- how to upload a file
- how archive continuation works
- how session reset works
- what users can expect from file return
- where Codex and Claude behavior may differ

### Phase 3 Completion Criteria

Phase 3 is complete when new users can discover the main flows from Telegram itself and recover from common dead ends without operator guidance.

## File and State Model Implications

This design assumes the current state layout remains file-based.

Expected state artifacts continue to include:

- session state
- access state
- runtime state
- audit log
- file workflow state

New work should extend these files carefully rather than invent a second persistence system.

## Error Handling Principles

All three phases should follow the same product rules:

- prefer explicit failure categories over generic text
- never silently swallow operationally relevant failures
- keep user-facing errors short and actionable
- keep operator-facing errors concrete and inspectable

## Testing Strategy

The implementation plan should preserve the current bias toward automated coverage.

The stable beta scope should include:

- unit tests for new state and classification behavior
- command tests for operator tooling
- service and delivery tests for user-facing Telegram flows
- regression tests for engine-specific file behavior

Manual verification should still be used for:

- real Telegram delivery behavior
- Windows-specific process invocation behavior
- service restart and recovery flows

## Rollout Strategy

Rollout should be phased with real user traffic:

1. complete Phase 1 and verify on the current operator account
2. complete Phase 2 and shift recovery workflows onto supported commands
3. complete Phase 3 and invite a small group of beta users

Do not start broad feature expansion before these three phases land.

## Recommended Milestone Definition

The stable beta milestone should be treated as complete when the bridge is:

- reliable enough for daily use
- operable without manual state surgery
- clear enough for a small number of users to self-serve the main workflows

At that point, the project can choose whether to move toward a richer product surface, such as stronger Telegram UX, a lightweight admin UI, or broader collaboration workflows.
