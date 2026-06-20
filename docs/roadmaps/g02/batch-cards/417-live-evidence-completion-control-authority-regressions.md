# 417 Live Evidence Completion Control Authority Regressions

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../090-live-evidence-completion-control-read-model.md`

## Purpose

Prove completion control read models do not grant task mutation, provider,
callback, interruption, recovery, or SCM authority.

## Scope

- Exercise read model, DTO, and routing-readiness records.
- Keep actual task-state mutation and desktop controls out of this lane.
- Keep provider and SCM execution authority closed.

## Acceptance Criteria

- [x] Read models cannot mutate task state.
- [x] DTOs cannot request provider or SCM effects.
- [x] Diagnostics routing cannot execute effects.
- [x] Future mutation/control lanes remain separate.

## Validation

- `cargo test -p nucleus-server live_evidence_completion_control_authority -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
