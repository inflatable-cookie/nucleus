# 348 Provider Session Stdio Validation Closeout

Status: planned
Owner: Tom
Updated: 2026-06-20
Milestone: `../076-codex-provider-session-and-stdio-persistence.md`

## Purpose

Validate provider session/stdio persistence and activate runtime observation
event-store linkage.

## Scope

- Run targeted and workspace validation.
- Update roadmap and gap indexes.
- Keep one clear next task.

## Acceptance Criteria

- [ ] Validation passes or blockers are recorded.
- [ ] `077` is activated only if persistence surfaces are stable.
- [ ] No raw provider material is persisted or exposed.

## Validation

- `cargo check --workspace`
- `cargo test --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
