# 137 Durable Dispatch Invocation Preflight Helper Test Split

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../041-durable-dispatch-invocation-preflight-split.md`

## Purpose

Move durable dispatch invocation preflight blocker/helper/test code into
focused modules if needed after the type/support split.

## Acceptance Criteria

- [x] Helper/test code is split only where it reduces real pressure.
- [x] Preflight behavior remains unchanged.
- [x] No provider write, callback response, process spawn, SCM mutation, remote
  transport, UI, or task behavior is added.

## Validation

- `cargo test -p nucleus-server durable_dispatch_invocation_preflight -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `git diff --check`
