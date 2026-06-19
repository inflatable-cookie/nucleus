# 289 Codex Constrained Live Send Smoke Boundary

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../064-codex-live-provider-send-readiness.md`

## Purpose

Add an opt-in boundary for the first constrained Codex live-send smoke.

## Scope

- Require complete preflight evidence.
- Require explicit operator policy enabling live send.
- Use sanitized write attempts and receipt/event persistence.
- Keep task mutation disabled.

## Acceptance Criteria

- [x] Live-send smoke is blocked by default.
- [x] Complete preflight and operator policy are required before execution.
- [x] Outcomes are recorded without raw provider payload retention.
- [x] Task mutation remains blocked.

## Validation

- targeted Codex/server tests
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if running a real Codex write needs operator confirmation.
