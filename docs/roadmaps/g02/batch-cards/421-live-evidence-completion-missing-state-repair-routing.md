# 421 Live Evidence Completion Missing State Repair Routing

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../091-live-evidence-completion-request-handler-diagnostics.md`

## Purpose

Represent missing completion state as deferred or repair-required diagnostics.

## Scope

- Handle no persisted completion records.
- Handle malformed or repair-required projection state.
- Keep repair state inspectable without executing repairs.

## Acceptance Criteria

- [x] Missing state returns deferred/empty diagnostics.
- [x] Repair-required refs are visible.
- [x] No automatic repair executes.
- [x] No mutation authority is granted.

## Validation

- `cargo test -p nucleus-server live_evidence_completion_missing_state_routing -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
