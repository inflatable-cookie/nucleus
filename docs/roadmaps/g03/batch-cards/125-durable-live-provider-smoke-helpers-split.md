# 125 Durable Live Provider Smoke Helpers Split

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../037-durable-live-provider-smoke-command-runner-split.md`

## Purpose

Move helper, parsing, and formatting code into focused support modules if the
model split does not reduce the command-runner front door enough.

## Acceptance Criteria

- [x] Helper code is split only where it reduces real front-door pressure.
- [x] Public command behavior remains unchanged.
- [x] No provider write, process spawn, SCM mutation, remote transport, UI, or
  task behavior is added.

## Validation

- `cargo test -p nucleusd durable_live_provider_write_smoke -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleusd`
- `git diff --check`
