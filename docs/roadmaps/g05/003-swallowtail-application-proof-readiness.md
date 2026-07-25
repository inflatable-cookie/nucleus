# 003 Swallowtail Application Proof Readiness

Status: planned
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

- [ ] isolate native desktop state without changing host or provider homes
- [ ] cancel the active Agent Chat turn through the normal product path
- [ ] persist exact completed, cancelled, timed-out, and failed truth
- [ ] run deterministic proof preparation through Effigy
- [ ] return one exact live-pilot handoff without making a provider call

## Execution Plan

### Batch 3.1 — Isolated Native Profile

- [ ] Execute card 007.
- [ ] Resolve one explicit desktop data root at startup.
- [ ] Keep database, review snapshots, and UI configuration under that root.
- [ ] Add the bounded Agent Chat deadline setting.

### Batch 3.2 — Cancellation And Terminal Truth

- [ ] Execute card 008.
- [ ] Carry a consumer cancellation signal into the active Swallowtail turn.
- [ ] Add the normal Tauri and Agent Chat UI cancellation path.
- [ ] Persist cancellation and deadline separately from failure.

### Batch 3.3 — Deterministic Native Readiness

- [ ] Execute card 009.
- [ ] Add the isolated native Effigy selector and safe evidence summary.
- [ ] Pass focused Rust, client, desktop, and docs validation without
  credentials or provider calls.

### Batch 3.4 — Live Pilot Handoff

- [ ] Execute card 010 only after separate authenticated-call approval.
- [ ] Freeze exact versions, route, state root, workload, and stop bounds.
- [ ] Return control before the first provider call.

## Acceptance Criteria

- [ ] normal user paths and 180-second deadline remain the defaults
- [ ] invalid explicit configuration fails before desktop state or provider
  effects
- [ ] cancellation remains available while the chat worker is active
- [ ] cancellation request and terminal outcome stay distinct
- [ ] safe persisted evidence can reconcile every deterministic scenario
- [ ] no raw provider material, secret, prompt, output, or user path is retained
- [ ] no live provider call occurs before card 010 authority

## Current Gate

The current sidebar lane modifies the same Tauri, Agent Chat, and server files.
Cards 007-009 stay planned until card 006 closes and its work is checkpointed.
Card 010 remains separately provider-gated.

## Batch Cards

Planned:

- `batch-cards/007-isolated-native-proof-profile.md`
- `batch-cards/008-agent-chat-cancellation-and-terminal-truth.md`
- `batch-cards/009-native-proof-selector-and-readiness.md`
- `batch-cards/010-live-pilot-handoff.md`
