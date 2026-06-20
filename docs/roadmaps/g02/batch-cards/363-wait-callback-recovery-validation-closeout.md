# 363 Wait Callback Recovery Validation Closeout

Status: planned
Owner: Tom
Updated: 2026-06-20
Milestone: `../079-durable-wait-callback-interruption-recovery-persistence.md`

## Purpose

Validate durable wait/callback/interruption/recovery persistence and activate
provider runtime hardening.

## Scope

- Run targeted and workspace validation.
- Update roadmap and gap indexes.
- Keep one clear next task.

## Acceptance Criteria

- [ ] Validation passes or blockers are recorded.
- [ ] Callback, cancellation, resume, and replacement promotion remain gated.
- [ ] `080` is activated only after persistence is stable.

## Validation

- `cargo check --workspace`
- `cargo test --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
