# 346 Decode Outcome Persistence

Status: planned
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

- [ ] Supported and unsupported decode outcomes persist.
- [ ] Parse failures remain inspectable.
- [ ] Raw payload retention is blocked.
- [ ] Decode records can be replayed into diagnostics.

## Validation

- `cargo test -p nucleus-server decode_outcome_persistence -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
