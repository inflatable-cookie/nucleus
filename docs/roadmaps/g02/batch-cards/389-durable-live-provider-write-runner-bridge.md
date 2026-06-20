# 389 Durable Live Provider Write Runner Bridge

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../085-durable-codex-live-provider-write-execution.md`

## Purpose

Bridge the existing Codex live `turn/start` smoke runner into the durable
provider-write evidence model.

## Scope

- Keep the live transport runner isolated from durable state mutation.
- Convert live outcome fields into sanitized durable evidence input.
- Map completed, failed, timed-out, blocked, and cleanup-required states.
- Preserve no raw payload, no raw stream, no task mutation, and no review
  acceptance guarantees.

## Acceptance Criteria

- [x] Live runner outcome maps to durable provider-write evidence input.
- [x] Completed outcomes include required thread, turn, status, and method
      milestones.
- [x] Non-completed outcomes remain inspectable.
- [x] The bridge performs no provider I/O in tests.

## Result

The existing Codex live `turn/start` smoke outcome now maps into durable
provider-write evidence input without duplicating transport code.

## Validation

- `cargo test -p nucleusd durable_live_provider_write_runner_bridge -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
