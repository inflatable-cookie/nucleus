# 345 Stdio Frame Source Persistence

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../076-codex-provider-session-and-stdio-persistence.md`

## Purpose

Persist bounded stdio frame source metadata for Codex runtime sessions.

## Scope

- Store sequence, direction, session refs, size/count metadata, decode refs,
  and evidence refs.
- Do not store raw frame payloads.
- Reject out-of-session or duplicate frame identities.

## Acceptance Criteria

- [x] Frame metadata survives reopen.
- [x] Duplicate frame ids are rejected or reconciled deterministically.
- [x] Raw payloads are not retained.
- [x] Persistence does not execute provider I/O.

## Validation

- `cargo test -p nucleus-server stdio_frame_source_persistence -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
