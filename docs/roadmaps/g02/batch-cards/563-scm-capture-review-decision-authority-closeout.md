# 563 SCM Capture Review Decision Authority Closeout

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../119-scm-capture-review-decision-persistence.md`

## Purpose

Validate SCM capture review decision persistence and keep all external effects
gated.

## Scope

- Prove review decisions do not create change requests.
- Prove review decisions do not mutate SCM or forge state.
- Update the implementation gap index and select the next lane.

## Acceptance Criteria

- [x] Change-request authority remains false.
- [x] SCM/forge/provider/callback/recovery authority remains false.
- [x] Validation passes or blockers are recorded.
- [x] Next lane is selected from evidence.

## Validation

- `cargo check --workspace`
- `cargo test --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
