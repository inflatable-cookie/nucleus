# 420 Live Evidence Completion Handler Composition

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../091-live-evidence-completion-request-handler-diagnostics.md`

## Purpose

Compose live evidence completion diagnostics DTOs from request-handler state.

## Scope

- Read persisted completion records where available.
- Compose read model and DTO.
- Keep state access read-only.

## Acceptance Criteria

- [x] Handler composition returns sanitized DTOs.
- [x] Completion ordering is deterministic.
- [x] Repair refs are preserved.
- [x] No mutation authority is granted.

## Validation

- `cargo test -p nucleus-server live_evidence_completion_handler_composition -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
