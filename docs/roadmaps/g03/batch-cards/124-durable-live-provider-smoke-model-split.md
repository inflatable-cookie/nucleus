# 124 Durable Live Provider Smoke Model Split

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../037-durable-live-provider-smoke-command-runner-split.md`

## Purpose

Move durable live provider smoke model/support types into focused submodules.

## Acceptance Criteria

- [x] Model/support types move out of the command-runner front door.
- [x] Public command behavior remains unchanged.
- [x] No provider write, process spawn, SCM mutation, remote transport, UI, or
  task behavior is added.

## Validation

- `cargo test -p nucleusd durable_live_provider_write_smoke -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleusd`
- `git diff --check`
