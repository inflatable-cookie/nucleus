# 003 Swallowtail Application Proof Readiness

Status: active
Owner: Tom
Updated: 2026-07-25

## Purpose

Make native Agent Chat safe and observable enough for Swallowtail's bounded
application-scale pilot. Keep all work consumer-owned and deterministic until
live authority is explicit.

## Governing Refs

- `../../contracts/008-storage-state-persistence-contract.md`
- `../../contracts/010-agent-session-lifecycle-contract.md`
- `../../contracts/030-swallowtail-agent-runtime-integration-contract.md`
- `../../architecture/product-workflow-ui-architecture.md`
- `../../architecture/repository-authority-map.md`
- Swallowtail g02 card 040

## Goals

- [x] isolate native desktop state without changing host or provider homes
- [x] cancel the active Agent Chat turn through the normal product path
- [x] persist exact completed, cancelled, timed-out, and failed truth
- [x] run deterministic proof preparation through Effigy
- [ ] return one exact live-pilot handoff without making a provider call

## Execution Plan

### Batch 3.1 — Isolated Native Profile

- [x] Execute card 007.
- [x] Resolve one explicit desktop data root at startup.
- [x] Keep database, review snapshots, and UI configuration under that root.
- [x] Add the bounded Agent Chat deadline setting.

### Batch 3.2 — Cancellation And Terminal Truth

- [x] Execute card 008.
- [x] Carry a consumer cancellation signal into the active Swallowtail turn.
- [x] Add the normal Tauri and Agent Chat UI cancellation path.
- [x] Persist cancellation and deadline separately from failure.

### Batch 3.3 — Deterministic Native Readiness

- [x] Execute card 009.
- [x] Add the isolated native Effigy selector and safe evidence summary.
- [x] Pass focused Rust, client, desktop, and docs validation without
  credentials or provider calls.

### Batch 3.4 — Live Pilot Handoff

- [ ] Execute card 010 only after separate authenticated-call approval.
- [ ] Freeze exact versions, route, state root, workload, and stop bounds.
- [ ] Return control before the first provider call.

## Acceptance Criteria

- [x] normal user paths and 180-second deadline remain the defaults
- [x] invalid explicit configuration fails before desktop state or provider
  effects
- [x] cancellation remains available while the chat worker is active
- [x] cancellation request and terminal outcome stay distinct
- [x] safe persisted evidence can reconcile every deterministic scenario
- [x] no raw provider material, secret, prompt, output, or user path is retained
- [x] no live provider call occurs before card 010 authority

## Current Gate

Cards 007-009 are complete in the working tree. Card 010 requires the
proof-readiness changes to be checkpointed so the exact Nucleus source can be
fixed. Installed Codex and catalogue probes plus every live provider call
remain separately gated.

## Batch Cards

Completed:

- `batch-cards/007-isolated-native-proof-profile.md`
- `batch-cards/008-agent-chat-cancellation-and-terminal-truth.md`
- `batch-cards/009-native-proof-selector-and-readiness.md`

Planned:

- `batch-cards/010-live-pilot-handoff.md`
