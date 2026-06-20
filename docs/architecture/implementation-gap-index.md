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

- `effigy doctor` currently fails on `scan.god-files`
- the current doctor report has six god-file errors and warning-sized files
  remain across active server surfaces
- `crates/nucleus-server/src/lib.rs` has been restored to a compact crate
  front door
- shared Codex supervision test fixtures now reduce repeated callback,
  interruption, and recovery setup
- warning-sized Codex supervision files still show pressure across callback,
  interruption, turn-start, smoke, and session surfaces
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
- `nucleus-server` has Codex recovery need, admission, sanitized
  `thread/resume` envelope, outcome, receipt, and read-only diagnostics
  records for process exit, reconnect, server restart, provider identity
  mismatch, repair-required, replacement-thread, failed, and unsupported
  recovery states.
- `nucleus-server` routes combined Codex provider diagnostics through the
  control API as a read-only `codex_provider` diagnostics domain.
- `nucleus-server` has provider-service ownership records for service-owned
  command lanes, runtime streams, and reactor readiness without client command
  authority or task mutation authority.
- `nucleus-server` has provider instance registry records that separate
  configured provider instance ids from provider driver kinds and reject config
  evidence marked as containing secret material.
- `nucleus-server` has generic provider runtime outcome records that map to
  `HarnessProvider` runtime receipts and runtime observation event-store
  records while recording task-projection gaps.
- `nucleus-server` has provider command reactor records for admission, queueing,
  dispatch attempts, dry-run outcomes, and sanitized outcome persistence.
- `nucleus-server` routes Codex turn-start and callback response envelopes
  through provider command reactor dry-run paths without provider writes.
- `nucleus-server` now has Codex live-send preflight records, provider
  transport write attempt records, turn-start live-send receipt/event linkage,
  and a constrained live-send smoke boundary. These records select
  `turn/start` as the first live-write target while keeping execution blocked
  by default.
- `nucleus-server` persists task-agent work-unit source records as sanitized
  task-history entries and reads task work progress/task-agent diagnostics from
  those durable records without granting client mutation or provider execution
  authority.
- `nucleus-server` validates first-pass task-agent source-record runtime and
  review transitions before persistence.
- `nucleusd` exposes a Codex direct-connection `turn/start` real-write smoke
  gate. Default mode is blocked, confirmed mode is eligible, and both modes
  still report `provider_write_executed=false`.
- With explicit operator approval, `nucleusd` executed a local Codex app-server
  smoke through `initialize`, `initialized`, `thread/start`, `turn/start`, and
  `turn/completed`. The command retained only sanitized ids, counts, and status
  fields.
- `nucleus-server` has typed Codex live executor outcome records for accepted,
  completed, failed, timed-out, blocked, and cleanup-required attempts. These
  records preserve provider instance, write attempt, receipt, thread, turn,
  method-sequence, evidence, and cleanup identity while rejecting raw payload,
  raw stream, task mutation, callback response, cancellation, and resume
  authority.
- `nucleus-server` persists sanitized provider session binding records in the
  agent-sessions state domain. Bindings preserve provider instance, provider
  service, runtime session, provider session/thread refs, lifecycle, repair,
  and evidence refs while rejecting raw provider material, secret material,
  live handles, provider writes, and task mutation authority.
- `nucleus-server` persists Codex stdio frame ingestion evidence with explicit
  session refs, decode receipt refs, sequence, direction, bounded size/count
  metadata, and evidence refs. Duplicate frame source ids are rejected, and the
  persisted records keep raw stdio streams and raw provider payloads out of
  durable state.
- `nucleus-server` persists summarized Codex stdio decode outcomes for
  supported, unsupported, malformed, and recovery-required frames. Decode
  records keep method/status/shape/evidence refs inspectable without retaining
  raw JSON-RPC payloads or granting provider I/O/task mutation authority.
- `nucleus-server` exposes provider session bindings, stdio frame ingestion,
  decode outcomes, and runtime receipts through the read-only Codex transport
  diagnostics surface. The read model reports repair-required states and
  persisted evidence refs while keeping client authority false.
- `nucleus-server` derives deterministic runtime observation event identity
  records from provider instance, provider session binding, accepted frame
  acceptance records, decode outcomes, method, sequence, and observation kind.
  Unsupported observations keep visible identity, mismatched session/frame
  identity blocks promotion, and the records remain replay-safe.
- `nucleus-server` persists runtime observation ingestion cursor snapshots per
  observation stream. Cursors advance accepted observations, treat duplicates
  as deterministic no-ops, block stale sequences, flag sequence gaps as
  repair-required evidence, and never invoke provider I/O or mutate task state.
- `nucleus-server` persists accepted runtime observations as orchestration
  event-store records and stores sanitized event-persistence outcomes for
  accepted, duplicate, repair-only, and blocked observations. Rejected
  observations remain inspectable as repair evidence, and persistence never
  re-runs provider effects.
- `nucleus-server` rebuilds read-only runtime observation replay projections
  from event-store records and event-persistence outcomes. The projection
  deterministically reports session progress refs, wait-state refs, terminal
  refs, unsupported observation refs, repair needs, and evidence refs without
  provider I/O or task mutation authority.
- `nucleus-server` derives advisory task work-item runtime transition
  candidates from live observation persistence outcomes. Candidates represent
  running, waiting, completed, failed, cancelled, and recovery-required states,
  block missing work-item identity, and never mutate task state or copy raw
  provider material.
- `nucleus-server` admits live-observation work-item runtime transitions
  through a runtime-only gate. Valid transitions are admitted, invalid
  transitions fail closed, provider completion does not complete tasks, and
  review acceptance plus SCM mutation remain separate blocked authorities.
- `nucleus-server` projects admitted live-observation runtime transitions into
  replay-only task timeline entries by reference. Timeline projection is
  deterministic, skips blocked admissions, keeps raw provider material out, and
  grants no mutation authority.
- `nucleus-server` derives review-readiness records from completed
  live-observation runtime admissions only when validation, checkpoint, diff,
  receipt, or no-change evidence exists. Review acceptance and task completion
  remain separately blocked authorities.
- `nucleus-server` persists Codex live executor outcomes, runtime receipts, and
  completion observation events through local-store-backed state. Duplicate
  write attempt ids are rejected deterministically, records survive reopen, and
  persisted payloads retain sanitized refs and counts only.
- `nucleus-server` exposes persisted Codex live executor outcomes through the
  read-only Codex provider diagnostics surface. Diagnostics cover completed,
  failed, timed-out, blocked, accepted, and cleanup-required states without
  granting provider write, callback, cancellation, resume, or task mutation
  authority.
- `nucleus-server` has a task-backed Codex live execution policy gate that
  requires work item, task, project, runtime, adapter, host, operator, pathway,
  and tool-capability evidence before live executor admission. The gate blocks
  callback response, cancellation, resume, task completion, review acceptance,
  SCM mutation, raw provider material retention, invented next-task state, and
  large flat tool menus.
- `nucleus-server` has task-work-to-live-executor admission records that
  preserve task, project, provider instance, runtime session, live executor
  write attempt, and idempotency identity. The records block non-accepted
  policy, missing or mismatched identity, executor invocation, raw provider
  material requests, and task mutation requests.
- `nucleus-server` has task-work live executor receipt linkage records that
  connect work items to sanitized live executor outcomes and runtime receipt
  ids as reference-only task work refs. Completed provider outcomes are
  recorded as runtime progress without task completion or review acceptance;
  failed, timed-out, and cleanup-required outcomes remain inspectable.
- `nucleus-server` has read-only task-backed live execution diagnostics for
  admitted, blocked, completed, failed, timed-out, and cleanup-required states.
  The diagnostics include task work refs, live executor refs, receipt refs, and
  evidence refs without exposing raw provider material or granting provider,
  task, review, callback, cancellation, resume, or SCM authority.
- `nucleus-server` has a Codex callback response execution policy gate that
  requires callback request, admission, envelope, runtime, adapter, host,
  operator, callback-kind, response-shape, and tool-capability evidence before
  callback response execution admission. The gate blocks automatic callback
  answering, task completion, review acceptance, cancellation, resume, SCM
  mutation, raw callback material retention, raw provider payload retention, and
  task mutation authority.
- `nucleus-server` has callback-response-to-executor admission records that
  preserve callback request, callback response, envelope, provider callback,
  task, work item, provider instance, runtime session, write attempt, and
  idempotency identity. The records block non-accepted policy, missing or
  mismatched identity, executor invocation, raw callback material requests,
  task mutation, and review acceptance.
- `nucleus-server` has callback response execution receipt linkage records
  that connect admitted callback response write attempts to sanitized live
  executor outcomes and runtime receipt ids. Completed provider outcomes are
  recorded as runtime progress without task completion or review acceptance;
  failed, timed-out, blocked, and cleanup-required outcomes remain
  inspectable.
- `nucleus-server` has read-only callback response execution diagnostics for
  admitted, blocked, completed, failed, timed-out, and cleanup-required states.
  Diagnostics include callback refs, task/work refs, write attempt refs,
  receipt refs, and evidence refs without exposing raw provider material or
  granting provider, task, review, callback, cancellation, resume, or SCM
  authority.
- `nucleus-server` has a Codex provider interruption execution policy gate
  that requires interruption request, admission, envelope, runtime, adapter,
  host, operator, target, interruption-capability, and tool-capability evidence
  before interruption execution admission. The gate blocks automatic
  interruption, task completion, review acceptance, resume, callback answering,
  SCM mutation, raw provider material retention, raw callback material
  retention, recovery widening, and task mutation authority.
- `nucleus-server` has interruption-to-executor admission records that preserve
  interruption request, envelope, provider target, task, work item, provider
  instance, runtime session, write attempt, and idempotency identity. The
  records block non-accepted policy, missing or mismatched identity, executor
  invocation, raw provider or callback material requests, task mutation, review
  acceptance, resume, callback answering, and SCM mutation.
- `nucleus-server` has interruption execution receipt linkage records that
  connect admitted interruption write attempts to sanitized live executor
  outcomes and runtime receipt ids. Completed provider outcomes are recorded as
  runtime progress without task completion, review acceptance, resume,
  callback answering, or SCM mutation; failed, timed-out, blocked, and
  cleanup-required outcomes remain inspectable.
- `nucleus-server` has read-only interruption execution diagnostics for
  admitted, blocked, completed, failed, timed-out, and cleanup-required states.
  Diagnostics include interruption refs, task/work refs, write attempt refs,
  receipt refs, and evidence refs without exposing raw provider material or
  granting provider, task, review, callback, resume, or SCM authority.
- `nucleus-server` has a Codex provider recovery execution policy gate that
  requires recovery need, admission, envelope, runtime, adapter, host,
  operator, recovery-target, provider-identity, resume-capability, and
  tool-capability evidence before recovery execution admission. The gate
  blocks automatic resume, replacement-thread promotion, task completion,
  review acceptance, interruption, callback answering, SCM mutation, raw
  provider material retention, raw callback material retention, and task
  mutation authority.
- `nucleus-server` has recovery-to-executor admission records that preserve
  recovery need, envelope, provider thread, task, work item, provider
  instance, runtime session, write attempt, and idempotency identity. The
  records block non-accepted policy, missing or mismatched identity, executor
  invocation, raw provider or callback material requests, task mutation, review
  acceptance, replacement-thread promotion, interruption, callback answering,
  and SCM mutation.
- `nucleus-server` has recovery execution receipt linkage records that connect
  admitted recovery write attempts to sanitized live executor outcomes and
  runtime receipt ids. Completed provider outcomes are recorded as runtime
  progress without task completion, review acceptance, replacement-thread
  promotion, interruption, callback answering, or SCM mutation; replacement
  thread observations are inspectable but blocked from promotion.
- `nucleus-server` has read-only recovery execution diagnostics for admitted,
  blocked, completed, failed, timed-out, cleanup-required, and
  replacement-thread-observed states. Diagnostics include recovery refs,
  task/work refs, write attempt refs, receipt refs, and evidence refs without
  exposing raw provider material or granting provider, task, review, callback,
  interruption, replacement-thread promotion, or SCM authority.
- The next runtime target is a durable server-owned provider executor command
  gate so accepted execution requests can be persisted and replayed before
  broader provider write automation is attempted.
- `nucleus-server` has durable provider executor command records, sanitized
  local persistence, status/readback records, and read-only diagnostics. These
  records preserve lane admission, write-attempt, idempotency, task/work, and
  evidence identity without executing provider writes or granting client,
  provider, task, review, callback, interruption, recovery, replacement-thread
  promotion, or SCM authority.
- `nucleus-server` has durable executor dispatch selection, admission,
  outcome-linkage, and read-only dispatch diagnostics records. These records
  select queued commands, require explicit operator confirmation before
  dispatch admission, and link dispatch attempts to sanitized live executor
  outcomes and durable status records without enabling unattended provider
  writes.
- `nucleus-server` has durable dispatch invocation preflight and invocation
  request records. These records preserve dispatch, provider, runtime,
  write-attempt, idempotency, task/work, and evidence identity while keeping
  executor invocation, provider writes, task mutation, review acceptance,
  callback answering, interruption, recovery, replacement-thread promotion,
  SCM mutation, and raw material retention blocked.
- `nucleus-server` has durable dispatch executor handoff and outcome
  persistence reconciliation records. These records bridge accepted invocation
  requests to the live executor boundary, link sanitized live executor
  persistence back to durable status linkage, reject duplicate write-attempts,
  and keep raw payloads, raw streams, task mutation, review acceptance,
  callback answering, interruption, recovery, replacement-thread promotion,
  and SCM mutation blocked.
- `nucleus-server` exposes durable dispatch invocation diagnostics through the
  durable provider executor diagnostics surface. Invocation diagnostics are
  read-only and cover preflight, request, executor handoff, outcome
  persistence, evidence refs, blocked reasons, and next actions without
  granting executor, provider-write, or task authority.
- The next runtime target is durable dispatch invocation, then provider
  session/stdio persistence, runtime observation event-store linkage, and
  task-transition admission from live observations.
- `nucleus-engine` can project Codex fixture receipts into sanitized
  harness-provider runtime receipt records.

These are useful boundary proofs. They are not a live provider runtime.

Missing:

- real provider adapters
- full Codex process spawning and stdio lifecycle execution after admission
- live JSON-RPC/app-server decoding from a supervised process
- turn-start, callback-response, interruption, and recovery execution against
  the provider through a durable server-owned executor
- durable server-owned execution of Codex live writes outside the one-off
  `nucleusd` smoke command
- persistence for stdio frame source, decode outcome, and transport receipt
  records
- persistence for accepted runtime-observation event-store records
- interruption or recovery that reaches the provider and records
  local/provider outcomes
- persistence for interruption/cancellation records
- persistence for permission and user-input callback response records
- persistence for recovery records after server restart, process exit, or
  provider reconnect
- provider instance configuration and hot reload
- persistence for idempotency state across reconnect or restart
- backpressure behavior for high-volume deltas
- payload retention policy beyond metadata-only/evidence-ref records
- task-backed state transition admission from runtime observations
- broader task-agent transition admission after live provider observations
  start entering the orchestration event store
- checkpoint/diff/worktree linkage for turns and task work units
- concrete pairing/session/revocation protocol for remote provider hosts
- ACP callback, elicitation, terminal, file, session-mode, and cancellation
  handling beyond the Codex-first path
- observability contract for provider traces, process/resource metrics, and
  support bundles

Likely crates:

- `nucleus-agent-protocol`
- `nucleus-agent-adapters`
- `nucleus-engine`
- `nucleus-orchestration`
- `nucleus-server`

Next gate:

- define durable dispatch invocation preflight, then advance through request,
  handoff, outcome persistence, and diagnostics before widening runtime state
- keep future live provider writes behind explicit operator confirmation until
  they are routed through server-owned executor policy
- keep callback, cancellation, resume, and task mutation widening blocked until
  task-backed workflow state is harder to corrupt

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

The orchestration decision has been made, task-backed workflow proof is
implemented through read-only progress paths, repo-backed management projection
sync has explicit apply/review behavior, and Codex `turn/start`
transport-executor handoff now has authority, envelope, persistence,
first-response frame evidence, diagnostics, and a stopped-by-default real-write
smoke boundary.

The next checkpoint needs operator intent before implementation continues:

1. explicitly confirm a Codex `turn/start` real-write smoke lane, with the
   operator accepting that Codex may receive a real provider write
2. choose a different runtime lane that remains record-only or read-only
3. return to product workflow hardening before running live provider writes

Until that decision is made, keep checkout, worktree creation, commit, push,
branch mutation, publish, promote, merge, provider cancellation, provider
resume, callback response execution, task mutation, and real provider writes
gated.
