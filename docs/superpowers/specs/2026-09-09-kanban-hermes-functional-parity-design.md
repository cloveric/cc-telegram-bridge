# Kanban Hermes Functional Parity Design

Date: 2026-09-09

## Goal

Bring TaroCub's Kanban implementation to functional parity with the audited
Hermes Agent Kanban while preserving TaroCub's own product and architecture:

- TaroCub remains bot-first and Feishu/Lark-first.
- Every TaroCub instance keeps an isolated Kanban data boundary.
- Mini Bus and Agent Bus remain the execution topology.
- Existing `/board` and `/kanban` workflows remain compatible.
- Search, ASR, engine sessions, message delivery, and unrelated bot behavior are
  outside this change.

"Parity" means that a user can perform the same Kanban work and inspect the
same operational evidence. It does not mean copying Hermes branding, source
code, global storage layout, CLI-first assumptions, or autonomous-agent
philosophy.

The reference baseline is Hermes Agent `0.21.1` at commit
[`b7ac3ba1cdf89f94dfe86de27e01358b194f4053`](https://github.com/NousResearch/hermes-agent/commit/b7ac3ba1cdf89f94dfe86de27e01358b194f4053),
audited on 2026-09-09 against its
[Kanban guide](https://github.com/NousResearch/hermes-agent/blob/b7ac3ba1cdf89f94dfe86de27e01358b194f4053/website/docs/user-guide/features/kanban.md)
and
[CLI reference](https://github.com/NousResearch/hermes-agent/blob/b7ac3ba1cdf89f94dfe86de27e01358b194f4053/website/docs/reference/cli-commands.md).

## Product Boundary

This design adds or aligns:

- complete task lifecycle support;
- multiple boards inside one TaroCub instance;
- task editing, relationships, comments, attachments, events, and run logs;
- explicit dispatch, scheduling, claims, leases, retries, timeouts, and review;
- statistics, diagnostics, repair, import, export, and garbage collection;
- a full Web Kanban interface;
- consistent behavior across Web, CLI, Lark, Telegram, and model tools;
- a versioned parity manifest and upstream drift checks.

This design explicitly does not:

- create one global Kanban database shared by all bots;
- install, embed, invoke, or depend on Hermes at runtime;
- replace Mini Bus or Agent Bus with Hermes workers;
- enable hidden autonomous dispatch by default;
- copy the Hermes visual identity or reproduce its accessibility defects;
- change engine adapters, session ownership, search MCP ownership, ASR routing,
  group access control, or outbound delivery semantics;
- remove TaroCub-specific WIP, checklist, workspace, worktree, source-context,
  Mini Bus, or Agent Bus features.

## Current State And Confirmed Defects

The current implementation stores one board in `<stateDir>/board.json` and
offers task operations through a shared Telegram/Lark command handler. It
already supports dependencies, WIP limits, checklists, workspaces, run history,
heartbeats, stale-run recovery, review gates, dependency promotion, Mini Bus
dispatch, and Agent Bus dispatch.

The audit confirmed three defects that must be fixed before broadening scope:

1. Blocking a running task changes the task to `blocked` but leaves its active
   run as `running`. Unblocking then produces a `ready` task with a live run;
   starting it again fails, and stale recovery cannot repair it because recovery
   only scans tasks whose status is `running`.
2. Completing a review-gated task persists task status `review` but replies
   `Done` / `已完成`, and marks its run `done` before review approval.
3. At 390 px width, the Web console keeps a 220 px sidebar and compresses the
   main content into an unusable strip.

These are release-blocking regression tests for the new design.

## Design Principles

### Instance isolation

Each instance owns:

```text
~/.cctb/<instance>/kanban.sqlite
~/.cctb/<instance>/kanban-assets/
```

No query, UI endpoint, command, or model tool can cross this boundary merely by
supplying another instance name. The existing control UI may select an instance
only after its normal token, Host, Origin, and instance-name validation.

### Functional equivalence, native expression

Hermes capabilities are mapped to TaroCub concepts rather than copied
literally. For example:

- Hermes worker assignment maps to Mini Bus peers, Agent Bus instances, or a
  free-form human owner.
- Hermes daemon behavior maps to an explicit per-board dispatcher setting in
  the already-running TaroCub service.
- Hermes notifications map to TaroCub source conversations and explicit board
  subscriptions.
- Hermes model overrides map to TaroCub engine/model/effort execution metadata.

### One domain service

All mutation paths use `BoardService`. Channel handlers and UI routes do not
open the database or implement state transitions themselves. This prevents the
current command, card, and future Web behavior from drifting.

### Explicit automation

New boards default to manual dispatch. A user must enable automatic dispatch
per board. Enabling it is visible in `/board status`, Web settings, and audit
events. Review workers are also opt-in.

### Fail closed

The system never silently creates a replacement board, switches boards,
forgets a requested task, resets corrupt data, or converts a failed resume into
new work. Invalid state and revision conflicts produce actionable errors.

## User Model

### Boards

Every instance starts with a `main` board. Existing users continue to operate
that board without selecting it.

An instance may contain multiple boards. The active board is scoped by
`conversationKey`, so a private chat, group, and topic can select different
boards without changing another conversation. Every command also accepts an
explicit `--board <slug>` override.

Task IDs remain unique across the whole instance, not merely within a board.
Existing IDs such as `B1` remain valid and unambiguous after migration.

Primary board commands are:

```text
/board boards
/board create-board <name>
/board use <slug>
/board settings
/board export [slug]
/board import <file>
```

`/kanban` remains a complete alias, not a reduced command subset.

### Task lifecycle

The canonical task statuses are:

```text
triage -> todo -> scheduled -> ready -> running -> review -> done -> archived
```

`blocked` is a resumable side state reached from active non-terminal states.
Transitions are validated centrally rather than inferred independently by each
surface.

Compatibility rules:

- `/board add <title>` continues to create `todo` tasks.
- UI inbox creation and `/board triage <title>` create `triage` tasks.
- A task becomes `ready` only when all dependencies are done and its schedule
  is due.
- A task requiring review moves from `running` to `review`; it is not complete
  and does not promote dependents until approval.
- Rejecting review returns the task to `blocked` with the requested changes.
- Archiving is reversible and does not delete task history.
- Deletion is a separate, confirmed administrative operation.

### Run lifecycle

Run status is separate from task status:

```text
running | review_requested | succeeded | failed | blocked | cancelled | timed_out
```

The database enforces at most one `running` run per task. Any action that moves
a running task away from `running` must close the run in the same transaction.

Specific semantics:

- `complete` without a review gate closes the run as `succeeded` and the task
  as `done`.
- `complete` with a review gate closes the run as `review_requested` and the
  task as `review`.
- `approve` changes the task to `done`; it does not rewrite the historical run
  as though review never occurred.
- `block` closes an active run as `blocked` before changing task state.
- cancellation and timeout close both the claim and active run.
- recovery scans active runs and claims directly, even if task status is
  inconsistent, and records every repair as an event.

### Task data

The existing fields remain, with these additions:

- parent and child relationships;
- scheduled time and timezone;
- per-task execution engine, model, effort, timeout, and retry policy;
- comments with actor and timestamps;
- owned attachments with metadata and hashes;
- an append-only task event stream;
- claim and lease metadata;
- dispatch and review attempt evidence;
- monotonically increasing task revision for optimistic concurrency.

## Persistence Design

### Storage choice

The target store is a SQLite database per instance. SQLite is chosen for
transactional state transitions, atomic claims, partial unique indexes, event
history, multi-board querying, and safe concurrent access from the bot service
and control UI.

The implementation introduces a repository interface so domain behavior is
not tied to SQL:

```ts
interface KanbanRepository {
  transaction<T>(operation: (tx: KanbanTransaction) => Promise<T>): Promise<T>;
  readBoard(selector: BoardSelector): Promise<BoardSnapshot>;
  streamEvents(afterSequence: number, limit: number): Promise<BoardEvent[]>;
}
```

`SqliteKanbanRepository` is the production implementation. Tests may use an
in-memory SQLite database, but there is no second production JSON backend after
cutover.

The SQLite driver must preserve TaroCub's public Node.js support and pass an
installation spike before the storage commit lands. At design time, `sqlite3`
6.0.1 advertises Node.js `>=20.17.0`; the spike must verify fresh installs and
database smoke tests on supported macOS, Linux, and Windows architectures and
Node 20.17, 22, 24, and the current development runtime. If this gate fails,
the dependency choice returns to design review rather than silently raising the
project baseline or shipping a source-build-only install.

### Database configuration

On every connection:

- enable foreign keys;
- use WAL mode;
- configure a bounded busy timeout;
- keep write transactions short;
- use `BEGIN IMMEDIATE` for state transitions and claims;
- set owner-only permissions on the database, WAL, SHM, and asset directory;
- run schema migrations before serving Board requests.

### Logical schema

The initial normalized schema contains:

- `meta`: schema version and instance-scoped counters;
- `boards`: slug, name, settings, dispatcher policy, timestamps;
- `board_contexts`: active board by conversation key;
- `tasks`: identity, board, parent, lifecycle, execution policy, source actor,
  schedule, revision, and timestamps;
- `task_dependencies`: directed edges with cycle-safe insertion;
- `task_labels`;
- `checklist_items`;
- `artifacts`: lightweight references retained for compatibility;
- `attachments`: owned-file metadata, hash, size, and media type;
- `comments`;
- `runs`: attempts, outcome, heartbeat, logs, token/cost metadata, and errors;
- `claims`: owner, lease token, expiry, and heartbeat;
- `events`: append-only board/task/run state changes;
- `notification_subscriptions`;
- `migration_history`.

Large file contents are never stored as SQLite BLOBs. They are copied to
`kanban-assets` under a content hash and referenced by metadata.

Important constraints include:

- unique board slug per instance;
- unique task ID per instance;
- no self-dependency;
- foreign-key protected dependency and parent links;
- one active run per task through a partial unique index;
- one active claim per task;
- non-negative retry and timeout values;
- explicit checks for every task and run status;
- compare-and-swap updates using task revision.

### Migration from `board.json`

Migration is automatic on first Kanban access after upgrade and is serialized
with an instance-scoped migration lock:

1. Validate the complete legacy file with the existing parser. Invalid input
   aborts without creating a database.
2. Copy the original to a timestamped owner-only backup.
3. Build a temporary SQLite database and import all tasks into `main`,
   preserving task IDs, counters, source actors, dependencies, checklists,
   artifacts, workspaces, runs, review gates, and WIP limits.
4. Normalize old run names to the new run lifecycle without changing their
   historical meaning.
5. Run foreign-key checks, integrity checks, row-count reconciliation,
   dependency-cycle checks, and active-run invariants.
6. Atomically publish `kanban.sqlite` only after all checks pass.
7. Replace `board.json` with a deliberately fail-closed migration sentinel and
   retain the original backup. An older TaroCub build must error rather than
   treat the migrated board as empty.
8. Record a migration receipt containing source hash, backup path, row counts,
   schema version, and completion time, but no task content.

There is no long-lived dual write. `tarocub board export --legacy` produces an
explicit compatibility export, and `tarocub board rollback-migration` requires
confirmation and refuses to discard newer SQLite changes without first
exporting them.

No backup is automatically deleted.

### Corruption and repair

Database open, integrity, or migration failures never reset the board. The
operator receives a diagnostic with the instance, database path, failed check,
and repair command.

`tarocub board diagnostics` performs read-only checks. `tarocub board repair`
requires confirmation, takes a backup first, records actions, and supports:

- rebuilding derived indexes;
- closing orphaned claims and runs;
- reconciling invalid task/run pairs;
- detecting missing assets;
- quarantining unreferenced assets through an explicit GC operation.

## BoardService

`BoardService` owns every invariant and use case:

- board creation, selection, settings, import, and export;
- task CRUD and lifecycle transitions;
- dependency and parent/child graph validation;
- comments, attachments, checklist, labels, and artifacts;
- claim, heartbeat, release, timeout, and stale recovery;
- scheduling, dispatch selection, retries, and circuit breaking;
- review requests, approvals, and requested changes;
- statistics, diagnostics, repair, and GC;
- event append and audit projection.

Each mutation accepts an actor, expected revision when available, and an
idempotency key. It returns the updated aggregate plus emitted events. Channel
handlers localize the result; they do not infer outcomes from requested action
names.

Typed errors distinguish not found, invalid transition, dependency conflict,
WIP limit, claim conflict, stale revision, authorization, validation, storage,
and dispatch failures.

The existing `audit.log.jsonl` remains cross-system operational evidence. The
SQLite `events` table is authoritative for Board history. A committed event is
projected to the audit timeline after the transaction; projection failure does
not roll back valid Board state and is reported for retry.

## Dispatch And Review

### Manual mode

Manual behavior remains the default:

- `/board run <id>` claims and executes one ready task;
- `/board claim <id>` reserves work without starting an engine turn;
- `/board heartbeat <id>` renews the claim and active run;
- `/board release <id>` returns unstarted claimed work to its prior state.

### Automatic mode

`/board dispatch on` enables the dispatcher for the selected board. The
existing TaroCub service runs a bounded periodic tick; no second daemon is
required.

Each tick:

1. Promotes due scheduled tasks whose dependencies are done.
2. Selects ready tasks by priority, age, dependency order, and WIP limits.
3. Atomically claims a task with a lease token.
4. Resolves the assignee through Mini Bus, then Agent Bus, then the current
   instance when policy permits.
5. Starts a run and records dispatch evidence.
6. Renews the lease while progress or heartbeat events arrive.
7. Closes the run and applies review, retry, block, or completion semantics in
   one transaction.

The instance process lock normally guarantees one service, but database claims
remain authoritative because the Web console and recovery tools may be separate
processes.

Retries use bounded exponential backoff with per-board defaults and per-task
overrides. A board-level circuit breaker pauses automatic dispatch after a
configurable consecutive infrastructure-failure threshold. User/task failures
do not count as infrastructure failures.

### Review

Review may be performed by a named human owner, Mini Bus peer, Agent Bus
instance, or current instance role. Automatic reviewer execution is disabled
unless configured.

Review actions are:

- request review;
- approve;
- request changes with a required reason;
- reopen review;
- inspect the submitted run, artifacts, comments, and logs.

Only approval promotes dependents.

## Functional Parity Surface

The parity manifest classifies every audited Hermes operation as one of:

- `equivalent`: same user outcome with a TaroCub-native name;
- `superset`: TaroCub already provides additional behavior;
- `not-applicable`: Hermes runtime operation replaced by an existing TaroCub
  service responsibility, with the replacement named explicitly.

The target surface covers:

- board init/list/create/select/settings;
- task create/list/show/edit/specify/decompose;
- assign/reassign/reclaim and assignee discovery;
- model and execution overrides;
- dependency link/unlink and parent/child relationships;
- claim/release/heartbeat;
- comments and real attachments;
- complete/fail/block/unblock;
- schedule/promote;
- request review/request changes/reopen/approve;
- archive/restore/delete;
- dispatch/watch/status;
- stats, events, logs, and runs;
- notification subscribe/list/unsubscribe;
- import/export;
- diagnostics, repair, and GC.

Hermes `swarm` maps to explicit Board dispatch through Mini Bus or Agent Bus.
Hermes `daemon` maps to the existing TaroCub service plus a per-board dispatcher
setting. Neither requires a new global worker system.

## Command Surfaces

### CLI

Add `tarocub board ...` for local administration and scripting. Machine-readable
operations support `--json`; human output remains concise. Destructive commands
require `--confirm` in non-interactive use.

### Lark and Telegram

Existing commands remain valid. New subcommands use the same parser and
`BoardService` on both channels. Important additions include:

```text
/board boards | create-board | use | settings
/board triage | edit | delete | archive | restore
/board comment | attach | attachments | detach
/board link | unlink | parent | children
/board schedule | promote
/board claim | release | reassign | set-model
/board dispatch | watch | stats | events | logs
/board subscribe | unsubscribe
/board export | import | diagnostics | repair | gc
```

Lark task-card buttons carry task ID, board ID, expected revision, and an
idempotency key. A stale card action returns a refreshed card and does not apply
the transition to an unseen task revision.

Long output is paginated or attached as a file rather than truncated silently.

### Model tools

Expose an instance-local Kanban MCP surface to every supported engine:

```text
kanban_boards
kanban_list
kanban_get
kanban_create
kanban_update
kanban_comment
kanban_attach
kanban_claim
kanban_heartbeat
kanban_complete
kanban_block
kanban_request_review
kanban_events
```

The MCP server calls `BoardService`; it never grants direct database access.
It is bridge-managed and independent from the public DeepSeek web-search
plugin. Adapter capability tests must prove availability for Codex, Claude
Code, Kimi Code, DeepSeek Harness, and Antigravity without duplicate MCP
registration or search ownership changes.

Model mutations are limited to the current instance and current conversation's
active board unless the tool request carries an explicitly authorized board ID.

## Web Experience

The control console becomes a two-area application: `Instances` and `Kanban`.
The design remains recognizably TaroCub rather than a pixel copy of Hermes.

### Board view

- collapsible instance/board rail;
- board selector, search, filters, sort, and create action;
- 280 px minimum horizontal columns for all lifecycle states;
- drag and drop with explicit drop targets and revision-safe optimistic updates;
- compact cards showing priority, assignee, schedule, dependency state,
  checklist progress, review state, and active-run health;
- multi-select with bulk status, priority, assignment, archive, and delete;
- empty-state guidance and visible dispatcher state;
- event-driven refresh through authenticated server-sent events, with bounded
  polling fallback.

### Task detail

A side drawer provides:

- title, description, acceptance criteria, labels, and checklist;
- status, priority, assignee, execution target, schedule, timeout, and retry;
- dependencies, parent, children, and promoted dependents;
- comments and attachments;
- artifacts and delivery evidence;
- run history, current heartbeat, logs, and token/cost metadata when available;
- review controls;
- append-only event history;
- archive and confirmed delete actions.

### Responsive and accessible behavior

At mobile widths, the rail is closed by default and opened as an overlay. The
board occupies the viewport and remains horizontally scrollable; the detail
drawer becomes a full-screen sheet. No fixed 220 px sidebar remains.

Cards use separate drag handles, selection controls, and open-detail buttons.
Interactive elements are not nested. Every combobox has an accessible name,
keyboard board movement is supported, focus is restored after closing drawers,
and status is never conveyed by color alone.

Motion is limited to meaningful initial column reveal, drawer transition, and
drop confirmation, with reduced-motion support.

## Web API

The existing loopback bearer-token, constant-time token comparison, Host
validation, Origin validation, and instance-name validation remain mandatory.

Representative routes are:

```text
GET    /api/instances/:instance/boards
POST   /api/instances/:instance/boards
GET    /api/instances/:instance/boards/:board/tasks
POST   /api/instances/:instance/boards/:board/tasks
GET    /api/instances/:instance/tasks/:task
PATCH  /api/instances/:instance/tasks/:task
POST   /api/instances/:instance/tasks/:task/actions/:action
GET    /api/instances/:instance/tasks/:task/events
GET    /api/instances/:instance/tasks/:task/runs
POST   /api/instances/:instance/tasks/:task/attachments
GET    /api/instances/:instance/kanban/events
```

Mutations require an idempotency key and expected task revision. API responses
use stable error codes and return refreshed state on revision conflict.

Attachment uploads are bounded, streamed, hash-verified, filename-sanitized,
and stored under the instance asset root. Local-path attachments resolve real
paths, reject traversal and symlink escapes, and obey the same workspace/state
sandbox rules as outbound delivery. MIME type is evidence, not trust.

## Security And Privacy

- Database files, WAL/SHM files, migration receipts, backups, and assets are
  owner-only.
- Board data may contain prompts, user IDs, chat IDs, topology, logs, and local
  paths and is classified as high sensitivity.
- Tokens, provider keys, and ambient engine credentials are never copied into
  task data, comments, logs, events, exports, or diagnostics.
- Model tools receive bounded records and logs, not arbitrary state-directory
  access.
- Import rejects unknown schema versions, unsafe paths, oversized payloads,
  duplicate IDs, cycles, invalid transitions, and cross-instance references.
- Export redacts configured sensitive fields and requires an explicit option to
  include detailed logs or source actor identifiers.
- Destructive repair, GC, delete, migration rollback, and bulk delete require
  itemized confirmation.
- Automatic dispatch never broadens Lark/Telegram access or Agent Bus trust.

## Delivery Plan

Implementation status as of 2026-09-09:

- Phases 0 and 1 shipped in `v0.1.320` and `v0.1.321`.
- Phase 2 ships in `v0.1.322`. Its domain and persistence APIs are available to
  existing internal callers, while the existing `/board` and `/kanban`
  commands keep their current behavior.
- Phases 3 and 4 remain pending. In particular, the expanded channel command
  set, Web Kanban, SSE, and per-engine Kanban MCP tools are not part of Phase 2.

### Phase 0: correctness hotfix

- Fix block/run closure and recovery invariants in the current store.
- Correct review-gated completion text and run outcome.
- Fix the mobile console layout.
- Add exact regression tests before each fix.

This phase can release independently and does not wait for SQLite.

### Phase 1: service and persistence foundation

- Add `BoardService` and typed domain errors around current behavior.
- Complete the SQLite driver portability spike.
- Add schema, migrations, backup, fail-closed sentinel, diagnostics, and
  migration tests.
- Migrate existing operations without changing command output except for the
  confirmed defects.

### Phase 2: lifecycle and evidence parity

- Add boards, triage, scheduling, parent/child links, comments, attachments,
  events, richer runs, model overrides, archive/restore, import/export, stats,
  diagnostics, repair, and GC.
- Add claims, leases, retries, timeouts, circuit breaker, explicit dispatcher,
  and complete review semantics.

### Phase 3: channel and Web parity

- Add CLI commands, Lark/Telegram commands and cards, Web APIs, SSE, complete
  Kanban UI, mobile behavior, and accessibility.
- Keep all existing commands as compatibility aliases.

### Phase 4: model tools and upstream guard

- Inject the Kanban MCP into all five engines.
- Add adapter capability probes and duplicate-registration checks.
- Commit the parity manifest and upstream drift test.
- Run real-engine, real-Lark, and browser dogfood before release.

Each phase is separately reviewable and releasable. No phase combines Kanban
work with unrelated adapter or delivery refactors.

## Testing And Acceptance

### Domain and persistence

- every valid and invalid transition;
- block-running closes the run atomically;
- recovery repairs inconsistent active runs regardless of task status;
- review completion reports review and records `review_requested`;
- dependency cycles and incomplete dependency starts are rejected;
- WIP and active-run unique constraints hold under concurrent processes;
- claim expiry and takeover are deterministic;
- retries, timeout, and circuit-breaker boundaries use fake time;
- comments, attachments, events, and logs preserve actor/order;
- migration preserves every legacy field and ID;
- failed migration leaves the original authoritative and unchanged;
- old builds fail closed on the migration sentinel;
- corruption never becomes an empty board;
- backup, export, import, repair, rollback, and GC are round-trip tested.

### Surface contracts

- CLI, Telegram, Lark, Web, and MCP invoke identical service operations and
  return equivalent state;
- `/kanban` remains a complete `/board` alias in mention-only groups;
- stale Lark cards and stale Web revisions cannot overwrite newer changes;
- pagination and large-log delivery do not silently truncate;
- each engine exposes exactly one Kanban tool set and preserves existing search
  MCP behavior.

### Browser verification

- create, edit, drag, schedule, assign, claim, comment, attach, review, archive,
  bulk edit, filter, and search through the real UI;
- desktop and 390 x 844 mobile screenshots;
- keyboard-only task and column movement;
- no serious or critical automated accessibility violations;
- no console errors, failed requests, or duplicate mutations;
- cross-process SSE update from a command executed outside the browser.

### Release gates

- build and full Vitest suite pass;
- SQLite fresh-install matrix passes;
- migration fixtures from all published Board schema shapes pass;
- secret/privacy scan is clean;
- backup and rollback are exercised, not merely documented;
- real Lark and Telegram task-card transitions pass on a disposable board;
- all configured bot instances restart cleanly and report the expected version;
- the parity manifest has no unclassified audited Hermes operation.

## Upstream Drift

Add a machine-readable manifest containing:

- audited Hermes version and commit;
- reference command and status inventory;
- TaroCub equivalent, superset, or not-applicable mapping;
- responsible tests;
- last verified date.

CI verifies that every manifest entry names an implemented capability and test.
It does not scrape or execute moving upstream code during ordinary builds.
When Hermes releases a new version, maintainers deliberately update the pinned
baseline, audit the delta, classify changes, and decide whether they fit
TaroCub's product boundary.

## Documentation

Update README, full reference, slash-command reference, state model, security
boundaries, event model, entrypoint map, release checklist, and operator help.

Documentation must say:

- feature parity is pinned to a named Hermes baseline;
- TaroCub is not Hermes and does not require it;
- boards remain isolated per bot instance;
- automatic dispatch is opt-in;
- `kanban.sqlite` is authoritative after migration;
- backups are retained and rollback is explicit;
- Mini Bus and Agent Bus remain execution topology;
- existing commands continue to work.

## Definition Of Done

This project is complete when:

1. The three confirmed defects are fixed and permanently covered.
2. Every audited Hermes Kanban user outcome is implemented, mapped to an
   existing TaroCub superset, or explicitly classified as not applicable.
3. No Kanban operation requires or exposes cross-instance global state.
4. Existing Board data migrates with verified backups and rollback.
5. Every supported user surface shares `BoardService` behavior.
6. The Web Kanban is usable and verified on desktop and mobile.
7. All five engines can use instance-local Kanban tools without changing search
   or other MCP ownership.
8. Existing TaroCub Board extensions and command compatibility remain intact.
9. Full automated, real-channel, browser, migration, security, and fleet gates
   pass before release.
