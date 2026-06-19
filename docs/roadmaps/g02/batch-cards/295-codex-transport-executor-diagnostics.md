# 295 Codex Transport Executor Diagnostics

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../065-codex-turn-start-transport-executor-handoff.md`

## Purpose

Expose Codex transport executor readiness, attempts, receipts, and blockers
through read-only diagnostics.

## Scope

- Add diagnostics read-model records.
- Route diagnostics through control API and DTOs if needed.
- Keep diagnostics read-only.
- Do not add UI panels.

## Acceptance Criteria

- [x] Clients can inspect executor readiness and blockers.
- [x] Diagnostics do not grant execution authority.
- [x] Raw provider payloads are not exposed.
- [x] Task mutation remains blocked.

## Validation

- targeted diagnostics/server tests
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if diagnostics routing would require broad DTO restructuring first.
