# 198 Steward Capture Apply Loop Fixtures

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../043-steward-scm-sync-automation-gate.md`

## Purpose

Prove steward recommendations across import apply, capture prep, and review
readiness loops.

## Scope

- Add fixtures for accepted, blocked, conflict, and review-required loops.
- Link steward decisions to projection and SCM evidence.
- Keep actions advisory.

## Acceptance Criteria

- Steward recommendations preserve existing projection gates.
- Fixtures cover blocked and conflict paths.

## Validation

- Targeted Rust tests for steward capture/apply loop fixtures.
- `cargo check --workspace`

## Stop Conditions

- Stop if steward fixtures bypass apply or capture evidence.

## Result

Added targeted steward sync tests proving decisions stay advisory, evidence
linked, and blocked when capture or review gates are missing.
