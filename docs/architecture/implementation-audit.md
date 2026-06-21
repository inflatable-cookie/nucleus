# Implementation Audit

Status: draft
Owner: Tom
Updated: 2026-06-19

## Purpose

Assess the Nucleus codebase against the current architecture and T3 Code
comparison.

This is not a bug list. It is a structural review of what exists, what is
missing, and what should block more feature work.

## Current Implementation Strengths

- Rust workspace boundaries are broad enough to keep domains separate.
- Most crates use `lib.rs` as a front door rather than a dumping ground.
- Local storage has a backend trait and SQLite implementation.
- Project and task records have typed storage codecs.
- Control API DTOs make the desktop proof shell depend on Rust-owned response
  shapes.
- Desktop panels are explicitly proof UI.
- Read-only command execution is narrow and policy-gated.
- Command evidence is sanitized before client display.
- Runtime readiness is separate from command history.
- SCM/forge, native harness, adapter registry, command policy, and agent
  protocol domains have type surfaces.

## Current Implementation Risks

### God Files

`effigy doctor` currently fails on `scan.god-files`.

Current report:

- 149 total findings
- 129 warnings
- 20 errors

The highest current error files are:

- `crates/nucleus-server/src/codex_supervision/turn_start_executor_smoke_boundary.rs`
- `crates/nucleus-server/src/codex_supervision/turn_start_stdio_execution_envelope.rs`
- `crates/nucleus-server/src/lib.rs`

Recent health delta:

- `control_envelope_dto.rs` dropped from an error-sized 449-line file to a
  39-line front door with focused `request`, `query`, and `protocol` modules.
- The control-envelope split removed one doctor error without changing the
  wire protocol or behavior.
- `apps/nucleusd/src/command_runner/durable_live_provider_write_smoke.rs`
  dropped from a 541-line error-sized file to a 385-line warning-sized front
  door with focused dispatch, evidence, labels, and test-support modules.
- The durable smoke split removed one doctor error without changing command
  behavior or enabling provider writes.
- `provider_scm_capture_dry_run_execution_persistence.rs` dropped to a
  103-line front door with focused diagnostics, helpers, tests, and type
  modules.
- `provider_durable_executor_dispatch_selection.rs` dropped to a 79-line front
  door with focused blocker, helper, test, and type modules.
- These two splits removed two more doctor errors without changing persistence,
  dispatch selection, SCM behavior, or provider write authority.
- `codex_supervision/callback_request_persistence.rs` dropped to a 74-line
  front door with focused codec, record-builder, test, type, and validation
  modules.
- The callback request persistence split removed one doctor error without
  changing callback request persistence, callback response authority, provider
  I/O, or task mutation authority.
- `provider_durable_dispatch_invocation_preflight.rs` dropped to a 76-line
  front door with focused blocker, helper, test, and type modules.
- The durable dispatch invocation preflight split removed one doctor error
  without changing preflight behavior, provider-write authority, or task/SCM
  mutation authority.
- `codex_supervision/runtime_observation_event_store_persistence.rs` dropped
  to an 80-line front door with focused codec, record-builder, store, test,
  and type modules.
- The runtime observation event-store persistence split removed one doctor
  error without changing event-store persistence, provider I/O, replay, or task
  mutation authority.
- `provider_completion_scm_capture_preparation_persistence.rs` dropped to a
  118-line front door with focused diagnostics, helper, record-builder, store,
  test, and type modules.
- The completion SCM capture preparation persistence split removed one doctor
  error without changing persistence behavior, SCM/provider authority, or task
  mutation authority.
- `provider_scm_capture_dry_run_persistence.rs` dropped to an 18-line front
  door with focused diagnostics, helper, record-builder, store, test, and type
  modules.
- The SCM capture dry-run persistence split removed one doctor error without
  changing persistence behavior, SCM/provider authority, process authority, or
  task mutation authority.

The detailed report is `.effigy/reports/doctor/scan-god-files.md`.

This should be treated as structural debt, not style cleanup.

### Server Crate Accretion

`nucleus-server` currently contains host API, engine-like domain services,
control DTOs, local process readiness, scheduler vocabulary, runtime effect
vocabulary, Tauri IPC boundary, local transport fixtures, seed data, and
command execution proof paths.

Risk:

- the crate is becoming the engine by accident
- future embedded desktop and remote host shapes may be harder to split

Likely correction:

- keep the existing engine/orchestration boundary active and split broad
  server internals before more provider/runtime work widens the host crate

### Record State Before Orchestration

The local store and state service persist records directly. That is useful for
bootstrap, but it does not yet answer:

- what is the canonical event history
- how projections are rebuilt
- how commands become events
- how runtime receipts connect to user-visible state
- how tasks map to sessions, turns, messages, activities, and checkpoints

Risk:

- later provider/runtime features bolt onto record mutation instead of a
  coherent orchestration spine

### Proof UI Scope

The desktop shell currently has several useful panels:

- projects
- tasks
- task detail
- command diagnostics
- runtime readiness
- control diagnostics

Risk:

- proof UI may look like product direction before UI design is settled
- TypeScript helper file is already large
- global CSS is large
- browser preview cannot test Tauri IPC-backed data flows

Likely correction:

- keep UI disposable
- split client helpers by domain
- avoid adding more panels until the core model is clearer

### Missing Runtime Systems

No implementation exists for:

- live harness/provider adapters
- provider process lifecycle execution
- durable provider runtime ingestion into the orchestration event store
- provider command reactor beyond inert scheduler admission
- live runtime event subscription
- conversation timeline
- checkpointing
- SCM driver registry
- forge provider registry
- source-control provider discovery/auth
- remote host transport
- pairing/auth session management
- credential/secret storage
- planning/memory/research/Effigy domain crates
- plugin system
- observability

These are not small gaps. They define the real product architecture.

### Codex Runtime Rebaseline

Current Codex runtime code is a boundary proof, not a live integration.

Implemented surfaces:

- metadata-only Codex app-server adapter descriptor and method allowlist
- capability and runtime ownership records for a Nucleus-owned local app-server
- schema evidence records from the probed Codex CLI surface
- lifecycle mapping records for thread, turn, interrupt, rollback, and close
- fixture-backed projection from Codex-shaped events into canonical runtime
  events or harness-provider receipt fixtures
- compile-only supervision readiness and handshake expectation records
- decoded-frame ingestion through the existing fixture projector
- unsupported observation records with metadata-only raw payload policy
- approval and user-input wait-state routing records
- task-scoped Codex runtime admission records into the inert scheduler
- task progress projection from accepted event, receipt, wait, and unsupported
  observations
- recovery gates that record uncertainty without retrying or resuming Codex
- sanitized Codex runtime receipt projection in the engine

Not implemented:

- spawning or supervising a real Codex app-server process
- stdio transport, JSON-RPC framing, reconnect, or process restart handling
- persisted provider session binding records
- appending provider observations to the orchestration event store
- deduplicating provider frames across replay or reconnect
- responding to approval or user-input callbacks
- provider-reaching cancellation/interruption from a task work item
- resume/recovery from durable state after host restart
- moving task work-item state from runtime observations through admitted
  orchestration events
- live client subscriptions for provider runtime progress

The next implementation lane should therefore start with live event acceptance
and persistence. It should not yet start broad provider execution or UI growth.

## Recommended Remediation Order

1. Stop proof-panel growth.
2. Normalize docs enough to govern execution.
3. Split oversized docs into authority indexes and focused contracts.
4. Decide the orchestration model.
5. Split or create engine/orchestration crate boundaries.
6. Treat warning-sized files as pressure when touched.
7. Rebaseline harness runtime before adding provider behavior.
8. Implement Codex live event acceptance through orchestration-owned event,
   receipt, session, and work-item refs.
9. Implement later features only through the new core model.

## Code Audit Questions

- Does `nucleus-server` remain a host wrapper, or become split into
  `nucleus-engine` plus host-specific crates?
- Is direct record mutation allowed after orchestration exists?
- Should current task/project command paths be migrated to command/event
  handling?
- Should `nucleus-local-store` store event logs as first-class records before
  more DTOs are added?
- Which UI helpers should move out of `control.ts`?
- Which CSS belongs in components instead of global styles?
- Which current tests are fixtures that should not become product contracts?
