# 287 Provider Transport Write Attempt Records

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../064-codex-live-provider-send-readiness.md`

## Purpose

Represent provider transport write attempts before widening execution behavior.

## Scope

- Add provider-neutral write attempt records.
- Include idempotency keys, transport target refs, sanitized evidence refs, and
  blocked/queued/written/failed statuses.
- Do not retain raw provider payloads.
- Do not mutate task state.

## Acceptance Criteria

- Transport write attempts are distinct from reactor dispatch attempts.
- Write attempt records can describe stdio now and other transports later.
- Raw payload retention remains disabled.

## Validation

- [x] targeted server tests
- [x] `cargo check --workspace`
- [x] `git diff --check`

## Stop Conditions

- Stop if transport write attempts require a broader transport contract change.

## Result

Added provider-neutral transport write attempt records with idempotency keys,
transport targets, sanitized evidence refs, and queued/blocked status.

Write attempt records are distinct from reactor dispatch attempts. They do not
execute provider writes, retain raw payloads, or mutate task state.
