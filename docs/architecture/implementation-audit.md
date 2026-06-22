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

`effigy doctor` now exits successfully. `scan.god-files` still reports warning
pressure, but no hard errors.

Current report:

- 139 total findings
- 139 warnings
- 0 errors

There are no current doctor error files.

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
- `codex_supervision/turn_start_executor_smoke_boundary.rs` dropped to a
  22-line front door with focused decision, diagnostics, test, and type
  modules.
- The turn-start executor smoke boundary split removed one doctor error
  without changing smoke boundary behavior, provider-write authority, callback
  authority, process authority, or task mutation authority.
- `codex_supervision/turn_start_stdio_execution_envelope.rs` dropped to a
  21-line front door with focused decision, test, and type modules.
- The turn-start stdio execution envelope split removed one doctor error
  without changing envelope behavior, provider-write authority, callback
  authority, process authority, or task mutation authority. The moved test
  module remains warning-sized.
- `codex_supervision/stdio_frame_ingestion_persistence.rs` dropped to a
  23-line front door with focused codec, event-builder, record-builder, store,
  test, and type modules.
- The stdio frame ingestion persistence split removed one doctor error without
  changing persistence behavior, raw stream policy, provider-write authority,
  process authority, or task mutation authority.
- The follow-on hard-gate batch split durable executor dispatch admission,
  provider command reactor, completion SCM capture admission persistence, and
  durable Codex live smoke persistence into focused modules.
- Remaining inline test modules for durable executor commands/status,
  dispatch invocation, Codex transport authority, runtime observation cursor,
  live workflow fixtures, live smoke boundaries, and live evidence task-state
  persistence were externalized where that removed hard doctor pressure without
  changing behavior.
- `nucleus-server/src/lib.rs` and `codex_supervision.rs` moved broad re-exports
  into `exports.rs` modules so the crate/module front doors are readable
  indexes again.
- `codex_supervision/recovery_execution_policy.rs` moved validation logic into
  a focused validation module.
- The current doctor result is green for errors: 139 warnings, 0 errors.

The detailed report is `.effigy/reports/doctor/scan-god-files.md`.

Remaining warnings should be treated as touch-when-needed structural pressure,
not as an unbounded cleanup queue.

Current warning distribution:

- 48 server Codex supervision warnings
- 40 server provider-surface warnings
- 12 server request/control/diagnostics warnings
- 18 other server/runtime warnings
- 6 app/client/CLI warnings
- 13 engine, local-store, agent, native-harness, SCM, and task warnings

The next implementation lane should split warning-sized files only when it
touches them. Warning-only cleanup is not the active product path.

Git branch/worktree runner state now reaches sanitized outcome persistence and
read-only control DTOs. This is the first branch/worktree setup proof that
spans authority, command argv planning, durable sanitized outcomes, diagnostics,
and client-safe counts without enabling commit, push, PR, forge, provider,
callback, recovery, task mutation, UI transport, or raw-output authority.

Git commit runner state now reaches the same shape: explicit authority,
non-shell argv planning, durable sanitized outcomes, diagnostics, and
client-safe counts. Commit message material is referenced by sanitized ref only;
raw message text is not persisted. Push, PR, forge, provider, callback,
recovery, task mutation, UI transport, and raw-output authority remain blocked.

Git push runner state now reaches the same shape. Remote target material is
kept to sanitized remote and branch refs, command planning uses non-shell
`git push <remote> HEAD:<branch>` argv, and PR/forge/provider/callback/recovery
task mutation, UI transport, and raw-output authority remain blocked.

Stopped forge pull-request runner state now reaches the same shape with one
important constraint: the adapter prepares sanitized provider-request metadata
only. It does not create pull requests, call forge APIs, run provider writes,
store raw title/body text, or retain raw provider payloads.

The Git/forge runner rebaseline confirms the four stopped runner proofs remain
warning-neutral, pass focused tests, and do not grant shell passthrough, forge
or provider writes, callbacks, interruption, recovery, task mutation, or raw
output retention. Provider auth and forge execution should move next through a
contract lane, not direct implementation.

Provider auth and forge execution now have a focused contract surface in
`027-provider-auth-forge-execution-contract.md`. The next implementation lane
should prove stopped admission and preflight records for credential refs,
network-authority refs, mutating-effect approval refs, idempotency keys,
recovery policy refs, and sanitized provider-response evidence refs. It should
not resolve real credentials or call forge networks.

Provider Readiness Overview now has a pure projection, read-only query/control
integration, serialized control-envelope DTOs, and `nucleusd`/Effigy
inspection. The output reports status, family counts, blockers, evidence
counts, and no-effect flags while omitting credential material and raw provider
payloads. The fixture-backed Tauri IPC command adapter can consume the same
serialized overview DTO without visible UI or provider effects. The next
implementation lane is a read-only desktop proof surface that renders the DTO
without granting provider refresh, credential resolution, provider effects,
task mutation, or raw payload display. That proof surface is now implemented
and validated. Local stopped seed evidence now proves represented
credential-status, repository-metadata, and pull-request read families in the
desktop overview without provider effects. The next gap is a read-only
drilldown from the overview into the existing read-intent projection. That
drilldown is now implemented in the desktop proof shell: it loads overview and
projection data together, renders source counts and read-intent entries, and
continues to expose no provider controls.

Stopped provider-auth and forge network-execution admission records now exist
in `provider_forge_network_execution_admission`. The module admits stopped
preflight only from prepared PR request records plus credential refs, network
authority refs, operator approval refs, idempotency keys, retry/recovery policy
refs, and sanitization policy refs. Deferred mutating effect families and real
credential resolution, provider network calls, callbacks, interruption,
recovery execution, task mutation, and raw provider payload retention are
blocked.

Stopped forge network execution preflight/control records now exist in
`provider_forge_network_execution_preflight`. The module turns ready admissions
into stopped execution-request preflights when provider context refs, target
provider refs, credential-use evidence refs, preflight evidence refs, planned
provider-response evidence refs, and policy refs are present. The control DTO
exposes counts only. Credential resolution, provider network calls, forge
effects, callbacks, interruption, recovery execution, task mutation, and raw
provider payload retention remain blocked.

Stopped forge network execution request/receipt records now exist in
`provider_forge_network_execution_request_receipt`. The module records stopped
execution request ids, runtime receipt refs, retry lineage, and recovery
classification refs from ready preflight state. It preserves idempotency and
planned provider-response evidence refs while blocking credential resolution,
provider network calls, forge effects, callbacks, interruption, recovery
execution, task mutation, and raw provider payload retention.

Stopped forge network execution outcome persistence/control records now exist
in `provider_forge_network_execution_outcome_persistence`. The module persists
sanitized outcome refs, duplicate no-ops, blocked and repair-required states,
diagnostics, and read-only control counts from request/receipt records. It
still blocks credential resolution, provider network calls, forge/provider
effects, callbacks, interruption, recovery execution, task mutation, and raw
provider payload retention.

The forge network stopped-runner rebaseline confirms the admission, preflight,
request/receipt, outcome persistence, and stopped PR runner request-preparation
proofs remain stopped by default. Focused tests pass, direct
network/process/provider execution tokens were not found in the audited
modules, and warning-sized file pressure remains warning-only.

Stopped provider credential-status refresh/control records now exist in
`provider_forge_credential_status_refresh`. The module consumes credential
refs, classifies current status into ready, repair, unknown, and unsupported
buckets, requires provider context, status evidence, and sanitization refs, and
exposes read-only control counts. It does not resolve credential material, call
provider networks, execute provider effects, run callbacks/interruption/recovery,
mutate tasks, or retain raw provider payloads.

Stopped provider credential-status refresh persistence/control records now
exist in `provider_forge_credential_status_refresh_persistence`. The module
persists sanitized refresh records, duplicate no-ops, blocked persistence
records, diagnostics, and read-only control counts through local artifact
metadata. It still blocks credential material, provider payloads, real
credential resolution, provider network calls, callbacks, interruption,
recovery execution, task mutation, and raw provider payload retention.

The provider-auth stopped-boundary rebaseline confirms credential-status
refresh/control, credential-status persistence/control, forge network
execution, and stopped PR request preparation remain stopped by default.
Focused tests pass, direct network/process/provider execution tokens were not
found in the audited modules, and warning-sized file pressure remains
warning-only.

Stopped provider repository metadata refresh/control records now exist in
`provider_forge_repository_metadata_refresh`. The module consumes provider
context refs, requires provider instance, forge provider, remote repo,
credential-status evidence, repository-metadata evidence, and sanitization
refs, and exposes read-only control counts. It does not resolve credential
material, call provider networks, execute provider effects, run
callbacks/interruption/recovery, mutate tasks, or retain raw provider payloads.

Stopped provider repository metadata refresh persistence/control records now
exist in `provider_forge_repository_metadata_refresh_persistence`. The module
persists sanitized refresh records, duplicate no-ops, blocked persistence
records, diagnostics, and read-only control counts through local artifact
metadata. It still blocks credential material, provider payloads, real
credential resolution, provider network calls, callbacks, interruption,
recovery execution, task mutation, and raw provider payload retention.

Stopped provider pull-request/merge-request refresh/control records now exist
in `provider_forge_pull_request_refresh`. The module consumes provider context
refs, requires provider instance, forge provider, remote repo, refresh scope,
credential-status evidence, repository-metadata evidence,
pull-request-refresh evidence, and sanitization refs, and exposes read-only
control counts. It does not resolve credential material, call provider
networks, execute provider effects, run callbacks/interruption/recovery, mutate
tasks, or retain raw provider payloads.

Stopped provider pull-request/merge-request refresh persistence/control records
now exist in `provider_forge_pull_request_refresh_persistence`. The module
persists sanitized refresh records, duplicate no-ops, blocked persistence
records, diagnostics, and read-only control counts through local artifact
metadata. It still blocks credential material, provider payloads, real
credential resolution, provider network calls, callbacks, interruption,
recovery execution, task mutation, and raw provider payload retention.

Credential-status, repository-metadata, and PR/MR refresh now prove the stopped
provider read-intent pattern. Further read-family fan-out should pause until a
generic projection/control surface can make those records useful without
copying the same module structure for every provider object family.

Generic provider read-intent projection/control records now exist in
`provider_forge_read_intent_projection`. The module projects persisted
credential-status, repository-metadata, and PR/MR refresh records into one
read-only aggregate surface with family counts, status counts, blocker counts,
evidence counts, and no-effect flags. It does not read credential material,
call provider networks, execute provider effects, mutate tasks, or retain raw
provider payloads.

Provider read-intent query composition now exists in
`provider_forge_read_intent_query`. The module reads the three persisted
stopped read families from local store, composes the generic projection, and
returns a read-only query result plus control DTO. It does not resolve
credential material, call provider networks, execute provider effects, mutate
tasks, or retain raw provider payloads.

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

Provider read-intent status:

- provider credential-status, repository metadata, and PR/MR refresh intents
  are represented and persisted as stopped records
- generic read-intent projection and local-store query composition are
  implemented
- in-process control handler access is implemented
- provider read-intent serialized control-envelope support is implemented as a
  read-only projection request/result shape with explicit no-effect flags
- provider read-intent is inspectable through `nucleusd query
  provider-read-intent` and `effigy server:query:provider-read-intent`
- provider read-intent is consumable through the Tauri IPC command adapter
  without visible UI or provider effects
- provider read-intent product consumption is selected as a server-owned
  Provider Readiness Overview projection before visible UI, live provider
  reads, or more read-family fan-out
- Provider Readiness Overview projection is implemented as a pure server
  projection over existing read-intent evidence
- Provider Readiness Overview query/control integration is implemented as a
  read-only server query and serialized response DTO
- Provider Readiness Overview desktop proof and local stopped seed evidence are
  implemented without provider refresh, credential resolution, provider
  effects, task mutation, or raw provider payload retention
- Provider Readiness Overview drilldown is implemented over the existing
  provider read-intent projection without adding new server provider effects

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
9. Close out the Provider Readiness product proof and select the next provider
   lane before provider refresh or effects.
10. Implement later features only through the new core model.

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
