# Implementation Gap Index

Status: draft
Owner: Tom
Updated: 2026-06-21

## Purpose

Track implementation gaps found during the stocktake.

This index separates missing product systems from cleanup work so the next
implementation lane can be chosen deliberately.

## Immediate Code Health Gaps

### God-File Pressure

Current state:

- `effigy doctor` currently exits successfully
- the current doctor report has 139 findings: 139 warnings and 0 errors
- `crates/nucleus-server/src/lib.rs` remains a compact crate front door
- the first health rebaseline split request-handler diagnostics tests,
  control-envelope diagnostics response tests, diagnostics query routing, and
  SCM review/preparation test modules
- later provider/runtime, live-smoke, SCM capture, Codex supervision,
  Convergence, and DTO work reintroduced broad files before the health reset
- no current god-file finding is error-sized
- `control_envelope_dto.rs` has been split from 449 lines into a 39-line front
  door plus focused request, query, and protocol modules
- `apps/nucleusd/src/command_runner/durable_live_provider_write_smoke.rs` has
  been split from a 541-line error-sized command-runner file into a 385-line
  warning-sized front door plus focused dispatch, evidence, labels, and
  test-support modules
- `provider_scm_capture_dry_run_execution_persistence.rs` has been split from
  an error-sized persistence file into a 103-line front door plus focused
  diagnostics, helpers, tests, and type modules
- `provider_durable_executor_dispatch_selection.rs` has been split from an
  error-sized dispatch-selection file into a 79-line front door plus focused
  blocker, helper, test, and type modules
- `codex_supervision/callback_request_persistence.rs` has been split from an
  error-sized callback request persistence file into a 74-line front door plus
  focused codec, record-builder, test, type, and validation modules
- `provider_durable_dispatch_invocation_preflight.rs` has been split from an
  error-sized preflight file into a 76-line front door plus focused blocker,
  helper, test, and type modules
- `codex_supervision/runtime_observation_event_store_persistence.rs` has been
  split from an error-sized runtime persistence file into an 80-line front door
  plus focused codec, record-builder, store, test, and type modules
- `provider_completion_scm_capture_preparation_persistence.rs` has been split
  from an error-sized SCM preparation persistence file into a 118-line front
  door plus focused diagnostics, helper, record-builder, store, test, and type
  modules
- `provider_scm_capture_dry_run_persistence.rs` has been split from an
  error-sized SCM dry-run persistence file into an 18-line front door plus
  focused diagnostics, helper, record-builder, store, test, and type modules
- `codex_supervision/turn_start_executor_smoke_boundary.rs` has been split
  from an error-sized smoke boundary file into a 22-line front door plus
  focused decision, diagnostics, test, and type modules
- `codex_supervision/turn_start_stdio_execution_envelope.rs` has been split
  from an error-sized envelope file into a 21-line front door plus focused
  decision, test, and type modules
- `codex_supervision/stdio_frame_ingestion_persistence.rs` has been split from
  an error-sized persistence file into a 23-line front door plus focused
  codec, event-builder, record-builder, store, test, and type modules
- `provider_durable_executor_dispatch_admission.rs`,
  `provider_command_reactor.rs`,
  `provider_completion_scm_capture_admission_persistence.rs`, and
  `provider_durable_codex_live_smoke_persistence.rs` have been split into
  focused front doors and support modules
- broad inline server test modules that were keeping files above the hard
  doctor threshold have been externalized into sibling `tests.rs` modules
- `nucleus-server/src/lib.rs` and `codex_supervision.rs` have focused export
  modules instead of broad re-export blocks in the front door
- `codex_supervision/recovery_execution_policy.rs` has a focused validation
  module
- recent SCM capture, review, decision, and change-request preparation work is
  productively scoped but has expanded too many broad server surfaces

Needed:

- close the doctor-green health batch and continue with product-value work
  rather than cleanup momentum
- treat warning files as pressure when those areas are touched
- prefer bounded mechanical test-module splits only when they improve ownership
- avoid turning broad historical doctor debt into unbounded cleanup

Warning pressure triage:

- server Codex supervision: 48 warnings. Treat as touch-when-needed pressure
  during Codex runtime work; do not open a standalone warning-split lane.
- server provider surfaces: 40 warnings. Split when adding provider behavior,
  persistence, diagnostics, or effect runners in those modules.
- server request/control/diagnostics surfaces: 12 warnings across request
  handlers, control DTOs, and diagnostics read models. Split only when adding
  query/control behavior.
- server other/runtime surfaces: 18 warnings across runtime readiness,
  process supervision, task runtime, local discovery, and authority helpers.
  Keep an eye on host-boundary accretion when touched.
- app/client/CLI surfaces: 7 warnings across desktop and `nucleusd`. Do not
  expand proof UI without splitting touched helpers/styles.
- engine/local-store/agent/native-harness/SCM/tasks: 13 warnings. Treat as
  domain-local pressure, not a repo-wide blocker.

Provider Readiness Overview product surface gap:

- server projection is complete
- read-only query/control integration is complete
- serialized control-envelope DTO support is complete
- `nucleusd` and Effigy root inspection are complete
- Tauri IPC command-adapter consumption is complete
- product consumption is selected as a read-only desktop proof surface
- desktop proof surface implementation and validation are complete
- local stopped provider-readiness seed evidence is complete
- desktop read-intent drilldown over the overview is complete

Needed:

- close out the provider-readiness product proof and select the next provider
  implementation lane deliberately
- keep any next visible/provider surface typed, sanitized, and effect-free
- avoid provider refresh, credential resolution, provider effects, task
  mutation, raw payload display, or durable UI design commitments

Policy:

- warnings do not block the next implementation lane
- any file that is warning-sized before a lane touches it should be split as
  part of that lane when the lane would materially grow it
- no warning-only cleanup tranche should be opened unless doctor errors return
  or ownership becomes ambiguous
- Git branch/worktree runner proof now has authority records, command adapter,
  sanitized outcome persistence, diagnostics, and read-only control DTOs
  without granting commit, push, PR, forge, provider, callback, recovery, task,
  UI, remote transport, or raw-output authority
- Git commit runner proof now has authority records, command adapter,
  sanitized outcome persistence, diagnostics, and read-only control DTOs
  without granting push, PR, forge, provider, callback, recovery, task, UI,
  remote transport, or raw-output authority

### Server Crate Accretion

Current state:

- `nucleus-server` owns host API, DTOs, local state, request handling, runtime
  readiness, command execution proof paths, scheduler vocabulary, and Tauri IPC
  helpers

Risk:

- the crate may become the engine by accident

Needed:

- keep `nucleus-engine` and `nucleus-orchestration` as the durable engine
  boundary
- move domain logic out of host/server wrappers before more provider runtime
  work

### Post-Convergence Boundary Audit

Current state:

- `crates/nucleus-server/src/lib.rs` is error-sized at 417 lines, mostly due
  to crate-root module declarations and broad re-exports.
- `crates/nucleus-server/src/codex_supervision.rs` is error-sized at 440
  lines, mostly due to a broad supervision front door and many re-exports.
- `crates/nucleus-server/src/control_envelope_dto.rs` was error-sized at 449
  lines; it is now split into a focused front door and request/query/protocol
  modules below warning threshold.
- `crates/nucleus-server/src/provider_records.rs` is still small enough at 132
  lines, but it shows the useful direction: group related provider record
  surfaces behind focused front doors instead of widening `lib.rs`.

Decision:

- do not continue Convergence work
- do not start another provider effect lane
- split `control_envelope_dto.rs` first because it is an error-sized server
  boundary file with existing submodule structure and low behavior risk

Needed:

- keep the control envelope split as the preferred pattern for server-boundary
  god-file repairs
- select the next split from current doctor evidence without adding behavior
- treat the durable smoke split as a successful health-only split: it reduced
  error count without enabling provider writes
- treat the SCM persistence and durable dispatch-selection splits as the same
  pattern: behavior-preserving modularization backed by focused tests and
  `cargo check -p nucleus-server`
- treat the callback request persistence split as the same pattern: it reduced
  doctor pressure without granting callback response or provider I/O authority
- treat the durable dispatch invocation preflight split as the same pattern:
  it reduced doctor pressure without granting provider-write or task mutation
  authority
- treat the runtime observation event-store persistence split as the same
  pattern: it reduced doctor pressure without changing event-store semantics
  or granting provider I/O/task mutation authority
- treat the completion SCM capture preparation persistence split as the same
  pattern: it reduced doctor pressure without granting SCM/provider/task
  mutation authority
- treat the SCM capture dry-run persistence split as the same pattern: it
  reduced doctor pressure without granting SCM/provider/process/task mutation
  authority
- treat the turn-start executor smoke boundary split as the same pattern: it
  reduced doctor pressure without granting provider-write/callback/process/task
  mutation authority
- treat the turn-start stdio execution envelope split as the same pattern: it
  reduced doctor pressure without granting provider-write/callback/process/task
  mutation authority
- treat the stdio frame ingestion persistence split as the same pattern: it
  reduced doctor pressure without granting provider-write/process/task mutation
  authority or raw stream retention
- treat the final hard-gate batch as the same pattern: it reduced doctor errors
  to zero by splitting support modules, externalizing tests, and moving broad
  exports/validators without granting new provider, process, SCM, UI, callback,
  recovery, interruption, or task mutation authority

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

Likely crate boundary:

- `nucleus-orchestration`, composed by `nucleus-engine`

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
- `nucleus-server` has explicit live-evidence review acceptance, task
  completion, completion projections, task-state transition admission, and
  task-state control records. Provider completion can now be reviewed,
  accepted, and projected into task state only through explicit operator
  records.
- `nucleus-server` has provider-neutral completion-to-SCM readiness records.
  Completed task-state history can produce promotion candidates, adapter
  metadata can describe Git-like or Convergence-like workflows, diagnostics
  report ready/unsupported/repair states, and authority regressions prove no
  SCM capture, publish, review request, merge, forge, provider, callback, or
  recovery effect executes.
- `nucleus-server` exposes completion-to-SCM readiness through read-only
  control diagnostics. The request handler reports missing task-state history
  as repair-required when no persisted task-state controls exist.
- `nucleus-server` persists live-evidence task-state control records as
  sanitized artifact metadata. Persisted records rebuild task-state history
  for completion SCM readiness diagnostics, duplicates are deterministic,
  blocked controls remain repair evidence, and invalid records do not create
  SCM readiness candidates.
- `nucleus-server` has completion SCM capture-admission records and diagnostics.
  Capture admission validates persisted readiness refs, blocks missing,
  unsupported, repair-required, mismatched, and effect-requesting inputs, and
  still executes no SCM, forge, provider, callback, interruption, recovery, or
  raw-material effects.
- `nucleus-server` persists completion SCM capture-admission records as
  sanitized artifact metadata. Persisted records retain refs, statuses, and
  blockers, read back in deterministic order, preserve blocked admissions as
  evidence, and can rebuild capture-admission diagnostics without executing
  external effects.
- `nucleus-server` exposes persisted completion SCM capture-admission
  diagnostics through read-only control diagnostics. The DTO and request
  handler expose counts only and grant no SCM, forge, provider, callback,
  interruption, recovery, or raw-material authority.
- `nucleus-server` has completion SCM capture-preparation records. Accepted
  persisted capture admissions produce provider-neutral preparation candidates,
  adapter-specific execution details stay in descriptive labels, diagnostics
  expose ready/unsupported/repair states, and authority proof still executes
  no SCM, forge, provider, callback, interruption, recovery, or raw-material
  effects.
- `nucleus-server` persists completion SCM capture-preparation records as
  sanitized artifact metadata. Persisted records retain refs, labels, plan
  status, blockers, and evidence refs, read back in deterministic order,
  preserve unsupported and repair-required plans as evidence, and rebuild
  diagnostics without executing external effects.
- `nucleus-server` exposes persisted completion SCM capture-preparation
  diagnostics through read-only control diagnostics. The DTO and request
  handler expose counts only and grant no SCM, forge, provider, callback,
  interruption, recovery, or raw-material authority.
- `nucleus-server` has SCM capture dry-run planning records. Persisted ready
  preparation records produce dry-run candidates, adapter capabilities describe
  Git-like and non-Git dry-run workflows, diagnostics summarize skipped,
  unsupported, and repair-required states, and authority proof still executes
  no SCM dry-run, capture, publish, forge, provider, callback, interruption,
  recovery, or raw-material effects.
- `nucleus-server` persists SCM capture dry-run planning records as sanitized
  artifact metadata. Persisted records retain refs, labels, plan status,
  blockers, and evidence refs, read back in deterministic order, preserve
  unsupported and repair-required plans as evidence, and rebuild diagnostics
  without executing external effects.
- `nucleus-server` exposes persisted SCM capture dry-run planning diagnostics
  through read-only control diagnostics. The DTO, envelope domain, and request
  handler expose counts only and grant no SCM dry-run, capture, publish, forge,
  provider, callback, interruption, recovery, or raw-material authority.
- `nucleus-server` has SCM capture dry-run execution gate records. Persisted
  ready dry-run plans can produce execution admissions, adapter capability
  records keep dry-run execution separate from capture/publish, receipt records
  retain sanitized refs and counts, and authority proof allows dry-run evidence
  without granting capture, publish, forge, provider, callback, interruption,
  recovery, or raw-output authority.
- `nucleus-server` persists SCM capture dry-run execution receipt records as
  sanitized artifact metadata. Persisted records retain receipt identity,
  terminal outcomes, counts, labels, and evidence refs, read back in
  deterministic order, preserve duplicate and blocked states, and rebuild
  diagnostics without rerunning SCM effects.
- `nucleus-server` exposes persisted SCM capture dry-run execution diagnostics
  through read-only control diagnostics. The DTO, envelope domain, and request
  handler expose counts only and grant no capture, publish, forge, provider,
  callback, interruption, recovery, or raw-output authority.
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
- `nucleus-server` persists sanitized callback request references, callback
  response linkage, interruption outcome linkage, and recovery outcome linkage
  across the durable workflow. Replacement-thread recovery observations remain
  repair-required evidence and are not promoted automatically.
- `nucleus-server` persists provider idempotency ledger records, retry
  reconciliation decisions, backpressure summaries, retention-policy decisions,
  and repair-required runtime records. These records prevent duplicate writes,
  unsafe automatic retries, raw material retention, and silent repair.
- `nucleus-server` exposes provider trace spans, support-bundle manifests,
  provider health summaries, and read-only observability diagnostics without
  granting provider, task, review, callback, cancellation, resume, or SCM
  authority.
- `nucleus-server` has a deterministic task-backed live workflow fixture that
  replays task work item admission, durable scheduler admission, live executor
  admission, sanitized outcome linkage, runtime receipt linkage, timeline
  projection, review-readiness separation, explicit review acceptance, and
  diagnostics without provider I/O.
- `nucleusd` exposes a stopped-by-default durable runtime smoke dry-run. It
  reports replay eligibility, explicit real-write intent, blocker state, and
  sanitized counts/refs while always reporting `provider_write_executed=false`.
- `nucleus-server` has live workflow authority regressions proving provider
  writes, callback answering, cancellation, resume, task mutation, review
  acceptance, SCM mutation, raw payload retention, and raw stream retention fail
  closed across policy, admission, receipt linkage, and retention surfaces.
- `nucleus-server` has a durable Codex live-smoke boundary over durable
  executor handoff records. The boundary distinguishes dry-run,
  confirmation-only, and confirmation-plus-effect modes without invoking the
  executor or writing to the provider.
- `nucleus-server` has an execution-free durable Codex live-smoke dispatch
  runner that assembles command, selection, dispatch admission, invocation
  preflight, invocation request, handoff, and boundary records. Dry-run and
  explicit real-write modes both reach the live executor boundary without
  executing provider I/O.
- `nucleus-server` persists durable Codex live-smoke evidence with sanitized
  evidence refs and accepted live-executor outcome/receipt refs for first write
  attempts. Duplicate write attempts no-op deterministically, and retention
  policy failures block persistence without raw material retention.
- `nucleus-server` compares persisted durable smoke evidence against the
  task-backed live workflow replay fixture. Missing receipt, outcome, or
  evidence refs become repair-required gaps, and authority widening is blocked
  from promotion.
- `nucleus-engine` can project Codex fixture receipts into sanitized
  harness-provider runtime receipt records.

These are useful boundary proofs. They are not a live provider runtime.

Missing:

- real provider adapters
- full Codex process spawning and stdio lifecycle execution after admission
- live JSON-RPC/app-server decoding from a durable supervised process, beyond
  the direct smoke and persisted record/replay surfaces
- turn-start, callback-response, interruption, and recovery execution against
  the provider through a durable server-owned executor
- durable server-owned execution of Codex live writes beyond the execution-free
  durable smoke handoff/boundary path
- interruption or recovery that reaches the provider and records
  local/provider outcomes
- provider instance configuration and hot reload
- backpressure behavior that actively applies flow control to high-volume
  provider deltas
- checkpoint/diff/worktree linkage for turns and task work units
- concrete pairing/session/revocation protocol for remote provider hosts
- ACP callback, elicitation, terminal, file, session-mode, and cancellation
  handling beyond the Codex-first path
- process/resource metrics beyond the first provider trace and support-bundle
  manifests

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

Next gate:

- implement stopped forge network outcome persistence/control from request and
  receipt records
- model sanitized stopped outcomes, runtime receipt refs, planned provider
  response evidence refs, retry lineage, recovery classification, and read-only
  control counts without resolving credentials or calling provider networks
- keep forge provider writes, callback execution, interruption, recovery, task
  mutation, and raw output retention blocked until stopped outcome persistence
  and control surfaces are proven

Current runner proof state:

- `nucleus-server` has Git branch/worktree runner authority records that admit
  future runner invocation only from admitted handoff records, explicit
  operator effect intent, and policy-approved branch/worktree target refs.
- The authority records keep shell execution false and continue to block raw
  output retention, commit, push, pull-request, forge, provider, callback,
  interruption, recovery, and task mutation authority.
- `nucleus-server` has a Git branch/worktree runner command adapter that builds
  structured argv for primary-tree branch checkout and isolated-worktree
  creation from ready runner-authority records. It does not spawn Git, use
  shell passthrough, persist raw output, or widen commit/push/PR/forge/provider
  authority.
- `nucleus-server` has Git commit runner authority records, command adapter,
  sanitized outcome persistence, diagnostics, and read-only control DTOs. The
  adapter builds `git commit --file <message-ref>` argv from ready authority
  records and stores only sanitized message refs, not raw commit message text.
- Push, PR, forge, provider, callback, interruption, recovery, task mutation,
  UI/remote transport, and raw-output authority remain blocked after commit
  runner proof.
- `nucleus-server` has Git push runner authority records, command adapter,
  sanitized outcome persistence, diagnostics, and read-only control DTOs. The
  adapter builds `git push <remote> HEAD:<branch>` argv from ready authority
  records and stores only sanitized remote and branch refs.
- PR, forge provider writes, callback, interruption, recovery, task mutation,
  UI/remote transport, and raw-output authority remain blocked after push
  runner proof.
- `nucleus-server` has stopped forge pull-request runner authority records,
  sanitized provider-request adapter records, outcome persistence, diagnostics,
  and read-only control DTOs. The adapter prepares provider request metadata
  only and stores sanitized provider, branch, and text-source refs.
- Pull-request creation, forge/provider writes, callback, interruption,
  recovery, task mutation, UI/remote transport, and raw-output authority remain
  blocked after stopped PR runner proof.
- The Git/forge runner rebaseline confirms branch/worktree, commit, push, and
  stopped PR request-preparation proofs share the same stopped-by-default
  authority, adapter/request adapter, sanitized outcome persistence, and
  read-only control DTO shape. Focused runner tests pass, new runner files stay
  below warning thresholds, and `effigy doctor` remains at 139 warnings and 0
  errors.
- Contract `027-provider-auth-forge-execution-contract.md` now owns
  provider-auth and forge network execution authority. It requires separate
  credential authority, network authority, SCM/forge authority, operator
  approval, idempotency, retry/recovery, and sanitized provider-response
  evidence before real provider writes.
- `nucleus-server` has stopped provider-auth and forge network-execution
  admission records in `provider_forge_network_execution_admission`. They
  carry credential refs, network-authority refs, operator approval refs,
  idempotency keys, retry/recovery policy refs, and sanitization policy refs,
  while blocking real credential resolution, provider network calls, callbacks,
  interruption, recovery execution, task mutation, raw provider payload
  retention, and deferred mutating effect families.
- `nucleus-server` has stopped forge network execution preflight/control
  records in `provider_forge_network_execution_preflight`. They carry provider
  context refs, target provider refs, credential-use evidence refs, preflight
  evidence refs, planned provider-response evidence refs, policy refs, and
  read-only control counts while blocking credential resolution, provider
  network calls, callbacks, interruption, recovery execution, task mutation,
  and raw provider payload retention.
- `nucleus-server` has stopped forge network execution request/receipt records
  in `provider_forge_network_execution_request_receipt`. They carry stopped
  execution request ids, runtime receipt refs, retry lineage, recovery
  classification refs, idempotency refs, credential-use evidence refs, and
  planned provider-response evidence refs while blocking credential resolution,
  provider network calls, callbacks, interruption, recovery execution, task
  mutation, and raw provider payload retention.
- `nucleus-server` has stopped forge network execution outcome
  persistence/control records in
  `provider_forge_network_execution_outcome_persistence`. They persist
  sanitized outcome refs, duplicate no-ops, blocked and repair-required states,
  diagnostics, and read-only control counts from request/receipt records while
  blocking credential resolution, provider network calls, callbacks,
  interruption, recovery execution, task mutation, and raw provider payload
  retention.
- The forge network stopped-runner rebaseline confirms focused forge network
  execution tests and stopped PR runner tests pass, direct
  network/process/provider execution tokens were not found in the audited
  modules, and warning-sized file pressure remains warning-only.
- `nucleus-server` has stopped provider credential-status refresh/control
  records in `provider_forge_credential_status_refresh`. They consume
  credential refs, classify current status into ready, repair, unknown, and
  unsupported buckets, require provider context, status evidence, and
  sanitization refs, and expose sanitized control counts while blocking
  credential material, provider payloads, real credential resolution, provider
  network calls, callbacks, interruption, recovery execution, task mutation,
  and raw provider payload retention.
- `nucleus-server` has stopped provider credential-status refresh
  persistence/control records in
  `provider_forge_credential_status_refresh_persistence`. They persist
  sanitized refresh records, duplicate no-ops, blocked persistence records,
  diagnostics, and read-only control counts while blocking credential
  material, provider payloads, real credential resolution, provider network
  calls, callbacks, interruption, recovery execution, task mutation, and raw
  provider payload retention.
- The provider-auth stopped-boundary rebaseline confirms focused
  credential-status, forge network, and stopped PR runner tests pass, direct
  network/process/provider execution tokens were not found in the audited
  modules, and warning-sized file pressure remains warning-only.
- `nucleus-server` has stopped provider repository metadata refresh/control
  records in `provider_forge_repository_metadata_refresh`. They consume
  provider context refs, require provider instance, forge provider, remote
  repo, credential-status evidence, repository-metadata evidence, and
  sanitization refs, and expose sanitized control counts while blocking
  credential material, provider payloads, real credential resolution, provider
  network calls, callbacks, interruption, recovery execution, task mutation,
  and raw provider payload retention.
- `nucleus-server` has stopped provider repository metadata refresh
  persistence/control records in
  `provider_forge_repository_metadata_refresh_persistence`. They persist
  sanitized refresh records, duplicate no-ops, blocked persistence records,
  diagnostics, and read-only control counts while blocking credential
  material, provider payloads, real credential resolution, provider network
  calls, callbacks, interruption, recovery execution, task mutation, and raw
  provider payload retention.
- `nucleus-server` has stopped provider pull-request/merge-request
  refresh/control records in `provider_forge_pull_request_refresh`. They
  consume provider context refs, require provider instance, forge provider,
  remote repo, refresh scope, credential-status evidence,
  repository-metadata evidence, pull-request-refresh evidence, and
  sanitization refs, and expose sanitized control counts while blocking
  credential material, provider payloads, real credential resolution, provider
  network calls, callbacks, interruption, recovery execution, task mutation,
  and raw provider payload retention.
- `nucleus-server` has stopped provider pull-request/merge-request refresh
  persistence/control records in
  `provider_forge_pull_request_refresh_persistence`. They persist sanitized
  refresh records, duplicate no-ops, blocked persistence records, diagnostics,
  and read-only control counts while blocking credential material, provider
  payloads, real credential resolution, provider network calls, callbacks,
  interruption, recovery execution, task mutation, and raw provider payload
  retention.
- Credential-status, repository-metadata, and PR/MR refresh prove the stopped
  provider read-intent pattern. Further issue, comment, review workflow, and
  status/check read-family fan-out is intentionally paused until a reusable
  projection/control surface exists.
- `nucleus-server` has generic provider read-intent projection/control records
  in `provider_forge_read_intent_projection`. They aggregate persisted
  credential-status, repository-metadata, and PR/MR refresh records into one
  read-only projection with family counts, status counts, blocker counts,
  evidence counts, and no-effect flags.
- `nucleus-server` has provider read-intent query composition in
  `provider_forge_read_intent_query`. It reads persisted credential-status,
  repository-metadata, and PR/MR refresh records from local store and composes
  the generic read-intent projection as a read-only query result/control DTO.

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

The orchestration decision has been made, task-backed workflow proof now has a
deterministic live-workflow replay fixture, and the durable provider runtime has
idempotency, retry, retention, repair, backpressure, support-bundle, health, and
authority regression coverage.

Recent evidence:

- one explicit Codex live provider-write smoke executed through the durable
  gate
- live result persisted sanitized evidence, live executor outcome id, runtime
  receipt id, and replay status
- replay reconciled successfully
- task completion and review acceptance stayed false
- reconciled live provider-write evidence now projects to task work candidates,
  persisted observations, review-readiness records, and read-only diagnostics
- explicit operator review decisions now admit over review-readiness records,
  persist accepted/rejected/needs-changes/abandoned decisions by reference, and
  expose read-only review diagnostics
- review acceptance is proven not to complete tasks; task completion remains a
  separate explicit command lane
- explicit operator task-completion commands now admit only over persisted
  accepted review decisions, persist completion records by reference, and
  expose read-only completion diagnostics
- rejected, needs-changes, abandoned, duplicate, and blocked review decisions
  cannot complete tasks, and completion still grants no provider, callback,
  cancellation, resume, SCM, or raw-material authority
- persisted explicit completions now project into deterministic task timeline
  entries, task-work progress records, read-model diagnostics, and an explicit
  SCM/provider authority-separation proof
- completion projections now compose into a server read-model record,
  sanitized control DTO, diagnostics routing-readiness record, and read-only
  authority proof
- completion projection diagnostics now route through the request-handler
  diagnostics query vocabulary and `All` snapshot as sanitized DTOs from local
  server state
- validated completion read-model refs now admit explicit task-state
  transition records and project deterministic task-history entries while
  blocking repair-required, skipped, duplicate, missing, provider, callback,
  interruption, recovery, SCM, and raw-material authority
- live evidence task-state transition control records now compose transition
  admission and task-history projection responses without granting provider,
  callback, interruption, recovery, SCM, or raw-material authority
- Git dry-run adapter proof records now define non-mutating status and
  diff-stat descriptors, map ready provider-neutral dry-run execution
  capabilities to Git descriptors, retain sanitized outcome refs and counts
  only, and block raw output, commit, branch, push, forge, provider, callback,
  interruption, and recovery authority.
- Git dry-run command execution-boundary records now model descriptor-backed
  command requests, runner-boundary handoffs, sanitized evidence capture, and
  authority regressions without invoking shell execution in core tests or
  retaining raw stdout, stderr, or diff material.
- Git dry-run command execution persistence now stores sanitized request,
  handoff, capture, summary-count, exit-status, and evidence-ref records in
  local state, reads them in stable order, blocks duplicate execution ids, and
  derives read-only diagnostics without raw Git output or mutation authority.
- Git dry-run execution diagnostics now route through the control API,
  response DTOs, request-handler diagnostics, and `All` snapshots from
  persisted state while keeping checkout, branch, commit, push, forge,
  provider, callback, interruption, recovery, and raw-output authority false.
- The first read-only Git runner proof now executes admitted status commands
  against a local temp repo, parses porcelain status and diff-stat output into
  sanitized count records, and proves mutating Git verbs, external effects, and
  raw-output persistence remain blocked.
- Read-only Git runner output now composes into sanitized evidence capture,
  existing Git dry-run execution persistence, and control diagnostics while
  keeping raw stdout/stderr/diff/path material transient and out of persisted
  records.
- SCM capture workflow projection now composes completion-capture refs,
  dry-run plan refs, Git execution persistence refs, diagnostics refs, and
  evidence refs into replay-only stage-state and diagnostics records with
  missing, completed, blocked, and repair-required states.
- SCM capture workflow diagnostics now route through the read-only control API,
  response DTOs, request-handler diagnostics, and `All` snapshots from current
  state while keeping mutation, external effect, and raw-output authority false.
- SCM capture operator review readiness now admits completed replay workflows,
  preserves missing, blocked, and repair-required blockers, summarizes review
  candidates, and keeps change-request, SCM, forge, provider, callback,
  interruption, recovery, and raw-output authority false.
- SCM capture review readiness now routes through sanitized control DTOs,
  diagnostics query vocabulary, aggregate snapshots, and request-handler
  diagnostics derived from persisted replay evidence while still creating no
  operator decisions and granting no SCM, forge, provider, callback,
  interruption, recovery, or raw-output authority.
- SCM capture operator review decisions now persist accepted, rejected,
  needs-changes, and abandoned decisions by readiness/workflow refs, block
  duplicate ids and invalid accepted decisions over blocked readiness,
  summarize decision outcomes, and keep change-request, SCM, forge, provider,
  callback, interruption, recovery, and raw-output authority false.
- SCM capture review-decision diagnostics now route through sanitized control
  DTOs, diagnostics query vocabulary, aggregate snapshots, and request-handler
  reads from persisted explicit decision records while still creating no
  change-request preparation and granting no SCM, forge, provider, callback,
  interruption, recovery, or raw-output authority.
- Adapter-neutral change-request preparation admission now admits only persisted
  accepted SCM capture review decisions, blocks rejected, needs-changes,
  abandoned, duplicate, and blocked decisions, keeps Git-only terminology out
  of the admission record, and grants no branch/snapshot, commit/publish,
  push/remote-publish, forge, provider, callback, interruption, recovery, or
  raw-output authority.
- Adapter-neutral change-request preparation admissions now persist by stable
  id, route through sanitized control DTOs, diagnostics query vocabulary,
  aggregate snapshots, and request-handler diagnostics, and still grant no
  branch/snapshot, commit/publish, push/remote-publish, forge, provider,
  callback, interruption, recovery, or raw-output authority.
- Adapter-specific change-request plan records now select Git-like,
  convergence-like, and unsupported adapter paths from persisted
  adapter-neutral preparation records. Git-like records scope branch, commit,
  push, and pull-request terminology to Git plans; convergence-like records
  scope snapshot and publish terminology separately; diagnostics summarize
  plan kinds and blockers without granting SCM, forge, provider, callback,
  interruption, recovery, or raw-output authority.
- Git change-request execution authority, command descriptors, stopped
  request records, preflight records, dry-run handoff records, sanitized
  dry-run outcomes, dry-run evidence, dry-run diagnostics, branch/worktree
  admission records, branch/worktree command descriptors, branch/worktree
  preflight records, and branch/worktree diagnostics now exist as
  stopped-by-default server records. Branch/worktree modes are explicit,
  reviewable dry-run evidence is required, and diagnostics grant no checkout,
  branch creation, worktree creation, commit, push, pull-request, forge,
  provider, callback, interruption, recovery, or raw-output authority.
- Git branch/worktree execution handoff records, sanitized outcome records,
  reviewable evidence records, and read-only diagnostics now carry the
  branch/worktree setup chain forward without running Git. They preserve
  preflight, descriptor, admission, dry-run evidence, dry-run outcome,
  dry-run handoff, request, authority, plan, task, repo, operator, and
  worktree mode identity; evidence explicitly does not grant commit, push, or
  pull-request readiness.
- Git commit admission records, commit command descriptors, commit preflight
  records, and read-only diagnostics now admit commit intent from reviewable
  branch/worktree evidence with explicit commit-message provenance. They do
  not create commits, build executable argv, create shell handoff, push, create
  pull requests, call forge/provider surfaces, mutate tasks, or retain raw
  output.
- Git push admission records, push command descriptors, push preflight records,
  and read-only diagnostics now admit push intent from ready commit preflight
  state with explicit remote target provenance. They do not execute pushes,
  create pull requests, call forge/provider surfaces, mutate tasks, or retain
  raw output.
- Forge pull-request descriptor records, dry-run evidence records, and
  read-only diagnostics now represent PR intent from ready push preflight
  state with explicit forge provider, base branch, head branch, title source,
  and body source. They do not create pull requests, execute forge/provider
  writes, mutate tasks, or retain raw output.
- Forge pull-request execution admission, preflight, and diagnostics now
  represent stopped-by-default PR creation authority from reviewable PR dry-run
  evidence with explicit operator approval, credential readiness, and remote
  branch visibility blockers. They do not create pull requests, execute
  forge/provider writes, mutate tasks, or retain raw output.
- Adapter-neutral change-request chain projection and diagnostics now summarize
  Git-like, Convergence-like, and unsupported provider stages without making
  commit, push, pull-request, snapshot, publish, or publication-review terms
  universal. The neutral projection uses isolated work area, local revision,
  remote share, and review request stages while preserving provider-specific
  refs, blockers, and no-effect authority flags.
- Adapter-neutral change-request chain persistence and read-only control DTOs
  now preserve stage/provider refs, duplicate projection outcomes, blocked
  projections, unsupported stages, and sanitized diagnostics without granting
  SCM execution, forge execution, provider writes, task mutation, callback,
  interruption, recovery, or raw-material retention authority.
- Convergence-like publication admission, preflight, and diagnostics now admit
  only persisted adapter-neutral chains with Convergence snapshot, publish, and
  publication-review provider refs. Git-like chains, duplicate persistence,
  blocked persistence, missing operator confirmation, destination gaps, and
  review-readiness gaps remain blocked while snapshot creation, publish,
  provider writes, task mutation, callback, interruption, recovery, and
  raw-output effects stay false.
- Convergence-like publication command descriptors and stopped request records
  now derive from ready publication preflight, preserve snapshot, publish, and
  publication-review provider-stage refs, carry stable idempotency keys, and
  still build no executable argv, create no provider handoff, create no
  snapshot, publish nothing, mutate no tasks, and retain no raw output.
- Convergence-like publication request persistence and read-only DTOs now
  preserve stopped request, descriptor, preflight, admission, projection, task,
  repo, idempotency, and provider-stage refs. Duplicate idempotency keys become
  deterministic no-op records, blocked requests stay inspectable, and
  provider handoff, snapshot creation, publish, publication review, provider
  writes, task mutation, and raw-material retention remain false.
- Convergence-like publication runner proof and sanitized runner evidence now
  derive only from persisted request records. Duplicate and blocked request
  persistence cannot run, idempotency refs remain visible, evidence contains
  bounded counts/status only, and runner invocation, provider handoff, snapshot
  creation, publish, publication review, provider writes, task mutation, and
  raw-output retention remain false.
- G03 health rebaseline passed focused adapter-neutral tests, focused
  Convergence publication tests, `CARGO_INCREMENTAL=0 cargo check -p
  nucleus-server`, docs QA, Northstar QA, whitespace checks, and the anchored
  `Next Task` placement check. The G03 tranche added 13 adapter-neutral and
  Convergence server modules plus matching `lib.rs` exports; `effigy doctor`
  remains governed by the known god-file scan failure/slow path rather than a
  new Convergence behavior failure.
- The G03 provider record modules are now grouped behind
  `provider_records.rs`. Root `lib.rs` keeps one module entry and one re-export
  for the grouped G03 provider surface instead of 13 module declarations and
  13 re-export lines, while the focused source files and module-local tests
  remain separate.
- Convergence publication runner evidence persistence and read-only DTOs now
  persist sanitized evidence with duplicate-safe ids, keep blocked evidence
  inspectable, expose persisted/duplicate/blocked/reviewable counts, and still
  permit no runner invocation, provider handoff, snapshot creation, publish,
  publication review, provider writes, task mutation, or raw-material
  retention.
- Convergence stopped runner command-adapter records and diagnostics now derive
  from persisted runner evidence, preserve idempotency and provider-stage refs,
  count runnable, blocked, duplicate, and unsupported states, and still permit
  no runner invocation, provider handoff, snapshot creation, publish,
  publication review, provider writes, task mutation, or raw-material
  retention.
- Convergence backend surface research now identifies `snap`, object upload,
  `publish`, lane-head sync, bundle creation, approval, promotion, release,
  and resolution publication as separate backend effects. Publication checks
  publisher permission, scope, gate, duplicate snap/scope/gate records,
  metadata-only gate policy, and object availability; promotion checks
  promotability, downstream gate relationship, superposition policy, approval
  count, and publisher permission.
- The SCM/forge contract now names the Convergence runner backend boundary:
  minimum inputs, reported backend capabilities, authority/preflight gates,
  and stopped-by-default rules for snap creation, object upload, publication,
  lane-head sync, bundle, approval, promotion, release, and resolution
  publication effects.
- G03 selected storage-backed stopped runner replay as the next Convergence
  lane before real backend integration. This should preserve adapter decisions
  and provider refs by replay id before any object upload, publication, lane
  sync, bundle, approval, promotion, release, or resolution-publication effect
  is admitted.
- Convergence runner replay records and diagnostics now persist stopped
  adapter decisions with duplicate-safe replay ids, optional sanitized
  provider refs, effect-family counts, and no backend, object upload,
  publication, lane sync, bundle, approval, promotion, release, resolution
  publication, provider write, task mutation, callback, interruption,
  recovery, or raw-material authority.
- Convergence local snap admission records and diagnostics now derive from
  replay records and authority inputs. They admit local snap creation only when
  source authority, execution authority, and workspace readiness are present,
  while command execution, actual `converge snap`, object upload, publication,
  lane sync, bundle, approval, promotion, release, resolution publication,
  provider write, task mutation, callback, interruption, recovery, and
  raw-material retention remain false.
- Convergence local snap command descriptors and stopped request records now
  derive only from admitted local snap records, preserve replay, admission,
  task, repo, source-authority, execution-authority, and idempotency refs, and
  still build no executable argv, spawn no command, create no snap, upload no
  objects, publish nothing, mutate no tasks, and retain no raw output.
- Convergence local snap request persistence and read-only control DTOs now
  preserve stopped request, descriptor, admission, replay, task, repo,
  source-authority, execution-authority, and idempotency refs. Duplicate
  idempotency keys become deterministic no-op records, blocked requests stay
  inspectable, and command spawn, actual `converge snap`, object upload,
  publication, lane sync, provider writes, task mutation, and raw-material
  retention remain false.
- Convergence local snap runner proof and sanitized evidence now derive from
  persisted local snap requests. Duplicate and blocked persistence cannot run,
  evidence contains only ids, counts, status, and sanitized refs, and command
  spawn, actual `converge snap`, object upload, publication, lane sync,
  provider writes, task mutation, callback, interruption, recovery, and
  raw-output retention remain false.
- Convergence local snap runner evidence persistence and read-only control
  DTOs now persist sanitized evidence with duplicate-safe ids, keep blocked
  evidence inspectable, expose persisted/duplicate/blocked/reviewable counts,
  and still permit no command spawn, local snap creation, object upload,
  publication, lane sync, provider writes, task mutation, or raw-material
  retention.
- Convergence local snap stopped runner command-adapter records and diagnostics
  now derive from persisted local snap runner evidence, preserve idempotency,
  request, admission, replay, task, repo, source-authority, and
  execution-authority refs, count runnable, blocked, duplicate, and unsupported
  states, and still permit no command spawn, actual `converge snap`, object
  upload, publication, lane sync, provider writes, task mutation, or
  raw-material retention.
- Convergence local snap runner replay records and diagnostics now persist
  stopped local snap adapter decisions with duplicate-safe replay ids, preserve
  persisted evidence, request, admission, source replay, task, repo,
  source-authority, execution-authority, and idempotency refs, count replayed,
  duplicate, blocked, and unsupported states, and still permit no command
  spawn, local snap creation, object upload, publication, lane sync, provider
  writes, task mutation, or raw-material retention.
- Convergence local snap execution preflight records and diagnostics now admit
  only replayed local snap runner replay records when operator confirmation,
  executable readiness, workspace readiness, and authority refs are present.
  Duplicate, blocked, unsupported, missing-authority, missing-prerequisite, raw
  material, and command-effect states remain inspectable, and process spawn,
  actual `converge snap`, object upload, publication, lane sync, provider
  writes, task mutation, and raw-material retention stay false.
- Convergence local snap spawn-request records and diagnostics now derive only
  from ready local snap execution preflight records. Blocked, duplicate, and
  unsupported preflight states remain inspectable, duplicate spawn request ids
  are deterministic no-ops, and process spawn, actual `converge snap`, object
  upload, publication, lane sync, provider writes, task mutation, and
  raw-material retention stay false.
- Convergence local snap spawn handoff records and diagnostics now derive only
  from ready stopped spawn requests. Blocked, duplicate, and unsupported spawn
  requests remain inspectable, duplicate handoff ids are deterministic no-ops,
  and process runner invocation, command spawn, actual `converge snap`, object
  upload, publication, lane sync, provider writes, task mutation, and
  raw-material retention stay false.
- Convergence local snap spawn receipt records and diagnostics now derive only
  from ready stopped spawn handoffs. Blocked, duplicate, and unsupported
  handoffs remain inspectable, duplicate receipt ids are deterministic no-ops,
  failed and cleanup-required states are represented for read-only diagnostics,
  and process runner invocation, command spawn, actual `converge snap`, raw
  stdout/stderr, object upload, publication, lane sync, provider writes, task
  mutation, and raw-output retention stay false.
- Convergence local snap spawn receipt control DTOs now expose sanitized
  receipt records through read-only ids, refs, status counts, blocker counts,
  and explicit no-authority flags. They preserve receipt, handoff, spawn
  request, preflight, replay, adapter, evidence, task, repo, authority, and
  idempotency refs without raw stdout/stderr, process material, command spawn,
  provider writes, task mutation, or raw-output retention.
- Forge network execution outcome persistence/control records now derive from
  stopped request/receipt records, persist sanitized outcome refs, duplicate
  no-ops, blocked and repair-required states, diagnostics, and read-only
  control counts, and still permit no credential resolution, provider network
  call, forge/provider effect, callback, interruption, recovery execution, task
  mutation, or raw provider payload retention.
- Forge network stopped-runner health and boundary rebaseline is complete. The
  audited modules still expose no direct network/process/provider execution
  tokens, and the next provider-auth lane should stay stopped by default.
- Stopped provider credential-status refresh/control records now classify
  credential refs without resolving credential material or calling provider
  networks.
- Stopped provider credential-status refresh persistence/control records now
  persist sanitized refresh records without resolving credential material or
  calling provider networks.
- Provider-auth stopped-boundary health rebaseline is complete. The audited
  modules still expose no direct network/process/provider execution tokens, and
  the next provider-auth lane should stay stopped by default.
- Stopped provider repository metadata refresh/control records now model
  repository metadata read intent without resolving credential material or
  calling provider networks.
- Stopped provider repository metadata refresh persistence/control records now
  persist sanitized repository metadata refresh records without resolving
  credential material or calling provider networks.
- Stopped provider pull-request/merge-request refresh/control records now model
  PR/MR read intent without resolving credential material or calling provider
  networks.
- Stopped provider pull-request/merge-request refresh persistence/control
  records now persist sanitized PR/MR refresh records without resolving
  credential material or calling provider networks.
- Provider-forge read-pattern consolidation is complete. Do not continue by
  stamping out issue, comment, review workflow, or status/check refresh modules
  unless the operator explicitly chooses that fan-out.
- Generic provider read-intent projection/control is complete. The next step is
  to compose it from local store reads instead of passing records manually.
- Provider read-intent query composition is complete. The next step is exposing
  the query through the server/control boundary without enabling provider
  writes.
- Provider read-intent control boundary is complete for in-process handler
  access. The serializable envelope still rejects provider read-intent results
  until a wire DTO contract is designed.
- Provider read-intent boundary rebaseline is complete. The next lane may add
  a serialized control-envelope DTO, but only for a read-only aggregate
  projection query/result with sanitized refs and no provider effects.
- Provider read-intent serialized control-envelope support is complete. The
  codec now round-trips projection requests and serializes aggregate/source
  counts, sanitized entry refs, and no-effect flags.
- Provider read-intent `nucleusd` query support is complete. The root Effigy
  task surface can now inspect the read-only projection through
  `server:query:provider-read-intent`.
- Provider read-intent Tauri IPC consumption is complete. The desktop command
  adapter can submit the serialized query and receive a sanitized read-only
  projection without provider effects.
- Provider read-intent product consumption is selected as a server-owned
  Provider Readiness Overview projection. The next lane should compose existing
  read-intent evidence into readiness status, blocker counts, evidence counts,
  and no-effect flags before visible UI, live provider reads, or more
  read-family fan-out.
- Provider Readiness Overview projection is complete as a pure server
  projection over existing read-intent evidence.
- Provider Readiness Overview query/control integration is complete as a
  read-only server query and serialized response DTO.
- Provider Readiness Overview desktop proof and local stopped seed evidence are
  complete without provider refresh, credential resolution, provider effects,
  task mutation, or raw provider payload retention.
- Provider Readiness Overview drilldown is complete over the existing provider
  read-intent projection without adding live provider behavior.
- Provider Readiness product closeout selected stopped status/check refresh as
  the next provider lane. Credential resolution, provider refresh, provider
  effects, UI polish, and warning-file cleanup remain deferred.
- Stopped status/check refresh type/control is implemented as a read-intent
  family with sanitized blockers and no-effect flags. Persistence and
  projection integration remain.
- Stopped status/check refresh persistence is implemented with sanitized
  records, duplicate/no-op behavior, diagnostics, and read-only control DTOs.
  Projection/query/DTO integration and desktop seed proof remain.

Next implementation gate:

1. fold persisted status/check refresh records into provider read-intent
   projection/query/DTOs and desktop seed proof before adding live refresh,
   credential resolution, provider effects, or raw payload retention
2. continue reducing god-file pressure opportunistically when touched

Until that lane proves durable authority and preflight, keep checkout,
worktree creation, commit, push, branch mutation, pull-request creation,
publish, promote, merge, provider cancellation, provider resume, callback
response execution, task mutation, and broad real provider writes gated.
