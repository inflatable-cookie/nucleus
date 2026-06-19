# 249 Codex Live Spawn Smoke Diagnostics

Status: ready
Owner: Tom
Updated: 2026-06-19
Milestone: `../056-codex-live-spawn-smoke-gate.md`

## Purpose

Expose read-only diagnostics for Codex live spawn smoke results.

## Scope

- Show accepted, blocked, failed, timed-out, and cleanup-required outcomes.
- Include next action and sanitized receipt refs.
- Do not add desktop panels.

## Acceptance Criteria

- Clients can inspect smoke readiness/result state without authority.
- Diagnostics do not expose raw output or credentials.

## Validation

- targeted serialization tests
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if diagnostics need UI design decisions.
