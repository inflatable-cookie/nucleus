# 360 Callback Response Durable Linkage

Status: planned
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

- [ ] Callback response linkage is reference-only.
- [ ] Completed provider outcome updates runtime progress only.
- [ ] Review acceptance and task completion remain blocked.
- [ ] Raw callback material is not exposed.

## Validation

- `cargo test -p nucleus-server callback_response_durable_linkage -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
