# 199 Steward Sync Diagnostics Read Model

Status: planned
Owner: Tom
Updated: 2026-06-19
Milestone: `../043-steward-scm-sync-automation-gate.md`

## Purpose

Expose steward SCM sync diagnostics without action authority leakage.

## Scope

- Include recommendations, evidence refs, blocked reasons, and next action
  kinds.
- Keep clients read-only.
- Do not add desktop polish.

## Acceptance Criteria

- Clients can inspect steward sync state.
- Diagnostics distinguish recommendation from execution.

## Validation

- Targeted Rust tests for steward sync diagnostics.
- `cargo check --workspace`

## Stop Conditions

- Stop if diagnostics expose mutating action authority.
