# 306 Codex Live Executor Receipt Persistence

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../068-codex-live-executor-integration.md`

## Purpose

Persist sanitized live executor outcomes and runtime receipts.

## Scope

- Add storage codec and repository path for live executor outcome records.
- Persist runtime receipt linkage for accepted and completed attempts.
- Preserve revision and idempotency checks.
- Add reopen/sort/query tests.

## Acceptance Criteria

- [x] Records survive backend reopen.
- [x] Duplicate write attempt ids are rejected or handled deterministically.
- [x] Runtime receipt linkage survives replay without raw material.

## Validation

- targeted server/local-store tests
- `cargo check --workspace`
