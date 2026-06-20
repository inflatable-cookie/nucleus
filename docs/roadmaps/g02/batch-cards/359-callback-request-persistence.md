# 359 Callback Request Persistence

Status: ready
Owner: Tom
Updated: 2026-06-20
Milestone: `../079-durable-wait-callback-interruption-recovery-persistence.md`

## Purpose

Persist provider callback and wait-state request evidence.

## Scope

- Store callback kind, provider refs, task/work refs, runtime receipt refs, and
  evidence refs.
- Preserve waiting-for-approval and waiting-for-user-input states.
- Do not answer callbacks.

## Acceptance Criteria

- [ ] Callback request evidence survives reopen.
- [ ] Missing provider/task identity blocks persistence.
- [ ] Callback answering authority remains false.
- [ ] Raw callback material is not retained.

## Validation

- `cargo test -p nucleus-server callback_request_persistence -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
