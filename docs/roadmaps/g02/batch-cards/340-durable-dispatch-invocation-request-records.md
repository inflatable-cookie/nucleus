# 340 Durable Dispatch Invocation Request Records

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../075-codex-durable-dispatch-invocation-gate.md`

## Purpose

Define deterministic invocation request records after preflight.

## Scope

- Preserve dispatch admission, provider instance, runtime session,
  write-attempt, idempotency, lane, method, task/work, and evidence identity.
- Block authority widening, raw material retention, task mutation, review
  acceptance, callback answering, interruption, recovery promotion, and SCM
  mutation.
- Keep request records separate from the actual executor call.

## Acceptance Criteria

- [x] Accepted preflight can produce one deterministic invocation request.
- [x] Invocation request ids are stable from dispatch/write-attempt identity.
- [x] Authority widening is blocked.
- [x] Request construction does not invoke the executor.

## Validation

- `cargo test -p nucleus-server durable_dispatch_invocation_request -- --nocapture`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
