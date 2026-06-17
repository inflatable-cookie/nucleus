# Implementation Audit

Status: draft
Owner: Tom
Updated: 2026-06-17

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

`effigy doctor` fails because `scan.god-files` reports one high finding:

- `crates/nucleus-command-policy/src/storage_codec.rs`

Warning-sized files are also accumulating in:

- `crates/nucleus-tasks/src/storage_codec.rs`
- `apps/desktop/src/styles.css`
- `crates/nucleus-server/src/control_envelope_dto/response.rs`
- `apps/desktop/src-tauri/src/lib.rs`
- `crates/nucleus-server/src/request_handler/task_commands.rs`
- `crates/nucleus-local-store/src/sqlite.rs`
- `crates/nucleus-server/src/request_handler/tests.rs`
- `crates/nucleus-server/src/tauri_ipc_command.rs`
- `crates/nucleus-server/src/control_serialization_readiness.rs`
- `apps/desktop/src/lib/control.ts`
- `crates/nucleus-server/src/control_envelope_dto/commands.rs`
- `crates/nucleus-server/src/secret_store.rs`
- `crates/nucleus-server/src/control_envelope_dto.rs`

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

- introduce an engine/orchestration crate or split server internals before
  provider runtime work begins

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

- real harness/provider adapters
- provider runtime ingestion
- provider command reactor
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

## Recommended Remediation Order

1. Stop proof-panel growth.
2. Normalize docs enough to govern execution.
3. Split oversized docs into authority indexes and focused contracts.
4. Decide the orchestration model.
5. Split or create engine/orchestration crate boundaries.
6. Reduce god-file findings that block `effigy doctor`.
7. Implement the next feature only through the new core model.

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

