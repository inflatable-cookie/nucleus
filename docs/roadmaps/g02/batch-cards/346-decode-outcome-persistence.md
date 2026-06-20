# 346 Decode Outcome Persistence

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../076-codex-provider-session-and-stdio-persistence.md`

## Purpose

Persist sanitized decode outcomes for observed Codex stdio frames.

## Scope

- Record decoded method, supported/unsupported status, parse failures,
  observation refs, and evidence refs.
- Store summarized shape only.
- Keep raw JSON-RPC payloads out of durable state.

## Acceptance Criteria

- [x] Supported and unsupported decode outcomes persist.
- [x] Parse failures remain inspectable.
- [x] Raw payload retention is blocked.
- [x] Decode records can be replayed into diagnostics.

## Validation

- `cargo test -p nucleus-server decode_outcome_persistence -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
