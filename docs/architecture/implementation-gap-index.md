# Implementation Gap Index

Status: draft
Owner: Tom
Updated: 2026-06-19

## Purpose

Track implementation gaps found during the stocktake.

This index separates missing product systems from cleanup work so the next
implementation lane can be chosen deliberately.

## Immediate Code Health Gaps

### God-File Pressure

Current state:

- `effigy doctor` no longer fails on `scan.god-files`
- the current doctor report has zero god-file errors and 38 warning findings
- former error files were split into focused module/test groups
- `scan.god-files` still reports warning-sized files across server DTOs,
  request handlers, desktop Tauri code, desktop CSS, local store, SCM, native
  harness, and engine test surfaces

Needed:

- treat warning files as pressure when those areas are touched
- avoid adding more broad DTO or CSS surfaces until ownership is clearer

### Server Crate Accretion

Current state:

- `nucleus-server` owns host API, DTOs, local state, request handling, runtime
  readiness, command execution proof paths, scheduler vocabulary, and Tauri IPC
  helpers

Risk:

- the crate may become the engine by accident

Needed:

- introduce both `nucleus-engine` and `nucleus-orchestration`
- move domain logic out of host/server wrappers before provider runtime work

### Proof UI Growth

Current state:

- desktop panels are useful for diagnostics
- UI design direction is not settled
- TypeScript and CSS are already large enough to need splitting
- task work progress is now visible in the proof shell through read-only DTOs

Needed:

- keep UI as disposable proof surface
- stop adding panels until the core model has a stable workflow target
- split client helpers by domain if proof UI work continues

## Missing Runtime Systems

### Orchestration Runtime

Missing:

- command/event/projection store
- deterministic replay
- projection rebuilds
- command validators
- event identity and sequencing
- runtime reactors

Likely crate:

- new `nucleus-orchestration`, composed by `nucleus-engine`

### Harness Runtime

Current state:

- Codex is the selected first bridged runtime target.
- `nucleus-agent-adapters` has a metadata-only Codex app-server descriptor,
  schema evidence, method allowlist, capability profile, runtime ownership
  metadata, and probe policy.
- `nucleus-agent-protocol` has Codex fixture projection, lifecycle mapping,
  canonical event payloads, runtime ownership metadata, and provider-ref
  retention types.
- `nucleus-server` has compile-only Codex supervision readiness, handshake
  expectations, server-owned session binding records, decoded-frame ingestion
  source records, decoded-frame ingestion through fixture mapping, unsupported
  observation records, duplicate-safe frame acceptance records, out-of-order
  and recovery-required frame classification, runtime-observation event-store
  linkage records, task-work observation link records, wait-state routing,
  task-runtime admission, progress projection, receipt linkage, and recovery
  gates, read-only Codex ingestion diagnostics DTOs, and pre-spawn
  owned-runtime instance, stdio frame source, and spawn-intent admission
  records, plus sanitized startup/decode receipt mappings.
- `nucleus-server` has a constrained Codex live spawn smoke request, runner
  adapter over the bounded local spawn path, sanitized smoke evidence and
  receipt mapping, and read-only diagnostics for accepted, blocked, failed,
  timed-out, and cleanup-required smoke outcomes.
- `nucleus-server` has Codex callback response request, admission, sanitized
  envelope, outcome, receipt, and read-only diagnostics records for permission
  and structured user-input callbacks.
- `nucleus-server` has Codex provider interruption request, admission,
  sanitized `turn/interrupt` envelope, outcome, receipt, and read-only
  diagnostics records.
- `nucleus-engine` can project Codex fixture receipts into sanitized
  harness-provider runtime receipt records.

These are useful boundary proofs. They are not a live provider runtime.

Missing:

- real provider adapters
- full Codex process spawning and stdio lifecycle execution after admission
- live JSON-RPC/app-server decoding from a supervised process
- turn-start command admission, policy, request envelope, and first response
  callback response execution against the provider
- persistence for stdio frame source, decode outcome, and transport receipt
  records
- persistence for accepted runtime-observation event-store records
- provider command reactor for `thread/start`, `turn/start`, callback
  responses, interruption, and close/unsubscribe
- cancellation that reaches the provider and records local/provider outcomes
- persistence for interruption/cancellation records
- persistence for permission and user-input callback response records
- resume/recovery after server restart, process exit, or provider reconnect
- provider instance configuration and hot reload
- persistence for idempotency state across reconnect or restart
- backpressure behavior for high-volume deltas
- payload retention policy beyond metadata-only/evidence-ref records
- task-backed state transition admission from runtime observations

Likely crates:

- `nucleus-agent-protocol`
- `nucleus-agent-adapters`
- `nucleus-engine`
- `nucleus-orchestration`
- `nucleus-server`

Next gate:

- start with Codex session recovery/resume records
- keep task mutation behind an explicit follow-up gate
- prove provider-native ids map to Nucleus-owned event, receipt, session, and
  work-item refs before letting runtime observations move task state

### SCM And Forge Runtime

Missing:

- SCM driver registry
- Git driver implementation
- Convergence adapter shape test
- forge provider registry
- provider discovery/auth
- branch/worktree/change-request workflows
- progress and conflict events

Likely crate:

- `nucleus-scm-forge`

### Management Projection Runtime

Current state:

- repo-backed project-management projection files exist for project, repo, and
  task records under `nucleus/`
- export writes deterministic TOML projection files
- import staging validates project/task projection files and preserves incoming
  records for review
- explicit import-apply command authority exists for validated project/task
  projection records
- expected-revision and no-silent-overwrite gates block stale active-state
  mutation
- invalid records, unsupported schema versions, semantic conflicts, and
  unresolved repair-required states block apply
- conflict detection, repair proposal, and steward-assistance routing exist as
  reviewable proof paths
- sanitized runtime receipts are persisted for accepted, blocked, skipped, and
  review-required apply outcomes
- a management sync review read model exposes staged, applied, blocked,
  conflict, repair, and receipt state to clients without making clients
  authoritative
- provider-neutral management capture command/admission records exist for
  accepted projection changes
- capture prep records link projection file refs, apply receipts, and review
  summary refs before share readiness can become review-ready
- Git-like and Convergence-like capture paths are represented without forcing
  commit, push, branch, pull-request, snap, or publication vocabulary into core
  records
- a management capture review read model exposes capture readiness, evidence,
  blocked reasons, and next actions without client authority
- Git management capture plan records map neutral capture admissions to
  adapter-specific labels without committing, pushing, or mutating refs
- Git capture dry-run envelopes admit read-only status/diff checks and block
  mutating provider commands
- sanitized Git status and diff evidence can make a Git capture plan
  review-ready
- primary-tree and isolated-location working-session execution prep records
  exist with guard checks, cleanup policy, and provider-mutation gates
- cleanup-ready and repair-required recovery records retain evidence refs and
  human approval requirements before destructive provider action
- provider-neutral change-request candidate records exist with evidence refs,
  review-boundary target, policy gates, and admission
- GitHub review-boundary descriptor mapping exists without network execution
- change-request evidence packages expose capture refs, work-session refs,
  status/diff summaries, validation summaries, and blocked reasons without
  client provider authority
- steward SCM sync decision records exist for recommendation, blocked,
  review-required, and no-action states
- steward sync decisions link sanitized evidence refs, assistance refs, blocked
  reasons, confidence, and requested next actions
- steward sync decisions are advisory only and keep provider mutation disabled
- steward sync diagnostics expose decision state to clients without client or
  provider mutation authority
- committable versus local-only policy is documented for first-pass records
- provider SCM mutation, share, publish, promote, and review-request behavior
  remains out of scope for this runtime

Missing:

- projection schema migration
- applying planning, accepted-memory, research, index, and artifact-reference
  projection records beyond first-pass project/task records
- provider command execution for checkout/worktree creation/cleanup
- actual provider SCM capture/share/publish integration
- steward execute-level automation over sync policy
- desktop sync controls, if the proof UI continues beyond diagnostics

Likely crates:

- `nucleus-projects`
- `nucleus-tasks`
- future planning/memory/research crates

### Remote Host Runtime

Missing:

- local socket or HTTP/WebSocket transport
- binary/client protocol decision
- pairing and auth
- host session store
- authority-map publication
- multi-host connection model

Likely crates:

- `nucleus-server`
- possible client protocol crate

### Workspace Runtime

Missing:

- terminal panels
- browser/preview panels
- editor panel backend
- SCM diff/commit panel backend
- layout persistence across clients
- tool broker between panels, harnesses, and host capabilities

Likely crates:

- `nucleus-workspaces`
- possible tool broker crate

### Planning, Memory, Research, And Effigy

Missing crates:

- `nucleus-memory`
- `nucleus-planning`
- `nucleus-research`
- `nucleus-effigy-integration`

Missing runtime:

- memory proposal/review flows
- guided project planning
- deep research runs and synthesis
- Effigy selector discovery, health summaries, and validation planning

## Suggested Next Implementation Gate

The orchestration decision has been made, the task-backed workflow proof has
validated a read-only progress path through fixtures, and repo-backed
management projection export/import/conflict staging and explicit
apply/review behavior have been hardened.

The most useful next checkpoint is:

1. implement a narrow Codex live event acceptance lane
2. add durable session binding and ingestion source records
3. map accepted provider frames into orchestration-owned events and sanitized
   receipts
4. expose read-only query state for accepted, unsupported, duplicated, and
   recovery-required observations
4. keep checkout, worktree creation, commit, push, branch mutation, publish,
   promote, merge, and review-request behavior gated until provider-specific
   adapter authority is proven
