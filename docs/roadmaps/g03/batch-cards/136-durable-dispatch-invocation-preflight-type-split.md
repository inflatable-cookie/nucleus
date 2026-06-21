# 136 Durable Dispatch Invocation Preflight Type Split

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../041-durable-dispatch-invocation-preflight-split.md`

## Purpose

Move durable dispatch invocation preflight type/support code out of the front
door.

## Acceptance Criteria

- [x] Type/support code moves only where it reduces real front-door pressure.
- [x] Public type names and preflight behavior remain unchanged.
- [x] No provider write, callback response, process spawn, SCM mutation, remote
  transport, UI, or task behavior is added.

## Validation

- `cargo test -p nucleus-server durable_dispatch_invocation_preflight -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `git diff --check`
