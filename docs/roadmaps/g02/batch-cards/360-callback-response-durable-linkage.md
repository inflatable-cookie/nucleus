# 360 Callback Response Durable Linkage

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../079-durable-wait-callback-interruption-recovery-persistence.md`

## Purpose

Link callback response attempts to durable dispatch, outcome, receipt, and
status records.

## Scope

- Preserve callback request, response, provider callback, dispatch, and
  evidence refs.
- Keep callback answers operator-gated.
- Block review/task mutation.

## Acceptance Criteria

- [x] Callback response linkage is reference-only.
- [x] Completed provider outcome updates runtime progress only.
- [x] Review acceptance and task completion remain blocked.
- [x] Raw callback material is not exposed.

## Validation

- `cargo test -p nucleus-server callback_response_durable_linkage -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
