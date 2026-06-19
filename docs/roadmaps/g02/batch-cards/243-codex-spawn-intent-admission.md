# 243 Codex Spawn Intent Admission

Status: planned
Owner: Tom
Updated: 2026-06-19
Milestone: `../055-codex-process-and-transport-acceptance.md`

## Purpose

Compose existing readiness gates into Codex spawn-intent admission records.

## Scope

- Use host authority, binary availability, auth posture, schema evidence,
  transport readiness, process-control readiness, and payload-retention policy.
- Return accepted or blocked spawn intent records.
- Do not spawn Codex as a side effect.

## Acceptance Criteria

- Spawn intent is blocked when any required gate is missing.
- Accepted intent remains an admission record, not process execution.
- Blocked intent includes actionable reasons.

## Validation

- targeted server tests
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if admission would bypass host authority or auth readiness.
