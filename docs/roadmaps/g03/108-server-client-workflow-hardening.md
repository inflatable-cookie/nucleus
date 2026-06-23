# 108 Server Client Workflow Hardening

Status: active
Owner: Tom
Updated: 2026-06-23

## Purpose

Make the existing server-owned read models, control envelopes, CLI queries, and
desktop IPC proof path coherent enough to guide the next implementation slice.

This lane does not design the final UI. It strengthens the disposable proof
interface and transport-neutral query surfaces so the server/host work is
usable without widening provider effects.

## Governing Refs

- `docs/contracts/007-server-boundary-contract.md`
- `docs/contracts/017-engine-host-authority-contract.md`
- `docs/contracts/022-engine-orchestration-boundary-contract.md`
- `docs/contracts/027-provider-auth-forge-execution-contract.md`
- `docs/architecture/system-inventory.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Inventory current query/control surfaces across server, `nucleusd`,
  Tauri IPC, and desktop proof UI.
- [x] Identify duplicate, missing, or server-only read models that should be
  client-safe.
- [ ] Add bounded read-only integration where the path is already governed.
- [ ] Keep Tauri UI disposable and Rust-side authority intact.
- [ ] Leave provider execution paused unless a later roadmap explicitly reopens
  it.

## Execution Plan

- [ ] Audit query/control surface coverage and record the gap matrix.
- [ ] Harden one or two read-only server/client paths that already have clear
  contracts.
- [ ] Keep DTOs sanitized, serialized, and testable without provider effects.
- [ ] Validate CLI, request-handler, and Tauri IPC parity where touched.
- [ ] Reassess whether the next lane should move to task/project workflow
  depth, client layout persistence, or continued server/client hardening.

## Batch Cards

Cards:

- completed: `batch-cards/429-server-client-query-surface-inventory.md`
- completed: `batch-cards/430-server-client-gap-matrix.md`
- completed: `batch-cards/431-server-client-next-read-model-selection.md`
- `batch-cards/432-server-client-control-envelope-parity.md`
- `batch-cards/433-server-client-cli-tauri-parity.md`
- `batch-cards/434-server-client-proof-surface-hardening.md`
- `batch-cards/435-server-client-validation.md`
- `batch-cards/436-server-client-next-lane-checkpoint.md`

## Acceptance Criteria

- [x] Query/control coverage is visible without reading scattered source
  files.
- [ ] Any new implementation is read-only, sanitized, and server/host-owned.
- [ ] CLI and Tauri IPC coverage do not drift where both claim the same query.
- [ ] Desktop proof UI remains disposable and does not become state authority.
- [ ] Provider execution remains paused.

## Stop Conditions

- The lane needs new provider execution, provider writes, credential material
  storage, task mutation, raw payload retention, or UI-triggered provider
  reads.
- The lane starts depending on final UI design decisions.
- A missing contract blocks safe implementation.
