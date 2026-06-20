# 353 Runtime Observation Linkage Validation Closeout

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../077-codex-runtime-observation-event-store-linkage.md`

## Purpose

Validate runtime observation event-store linkage and activate task-transition
admission.

## Scope

- Run targeted and workspace validation.
- Update roadmap and gap indexes.
- Keep one clear next task.

## Acceptance Criteria

- [x] Validation passes or blockers are recorded.
- [x] `078` is activated only if observation replay is deterministic.
- [x] Provider replay does not perform side effects.

## Validation

- `cargo check --workspace`
- `cargo test --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
