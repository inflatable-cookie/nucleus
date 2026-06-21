# 151 Turn Start Stdio Execution Envelope Type Split

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../046-turn-start-stdio-execution-envelope-split.md`

## Purpose

Move turn-start stdio execution envelope type/support code out of the front
door.

## Acceptance Criteria

- [x] Type/support code moves only where it reduces real front-door pressure.
- [x] Public type names and envelope behavior remain unchanged.
- [x] No provider write, callback response, process spawn, SCM mutation, remote
  transport, UI, or task behavior is added.

## Validation

- `cargo test -p nucleus-server turn_start_stdio_execution_envelope -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `git diff --check`
