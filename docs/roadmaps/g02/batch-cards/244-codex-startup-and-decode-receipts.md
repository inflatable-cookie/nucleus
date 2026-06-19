# 244 Codex Startup And Decode Receipts

Status: planned
Owner: Tom
Updated: 2026-06-19
Milestone: `../055-codex-process-and-transport-acceptance.md`

## Purpose

Map Codex startup, handshake, decode, and process-exit failures to sanitized
runtime receipts.

## Scope

- Add receipt mappings for blocked startup, failed startup, malformed frame,
  unsupported method, process exit, and recovery-required states.
- Link receipts to runtime instance and frame source refs.
- Do not copy raw provider streams or credentials.

## Acceptance Criteria

- Failure receipts are replay-safe.
- Receipt refs can be surfaced by diagnostics without raw payloads.
- Process failure does not imply task failure or rollback.

## Validation

- targeted engine/server tests
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if receipts require raw stdio payloads by default.
