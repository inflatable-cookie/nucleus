# 194 Change Request Evidence Package Read Model

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../042-change-request-preparation-boundary.md`

## Purpose

Expose a reviewable evidence package for change-request candidates.

## Scope

- Include capture refs, status/diff summaries, validation summaries, and
  blocked reasons.
- Keep clients read-only over authority.
- Do not add UI polish.

## Acceptance Criteria

- Clients can inspect change-request readiness.
- Missing evidence and blocked states are visible.

## Validation

- Targeted Rust tests for evidence package read model.
- `cargo check --workspace`

## Stop Conditions

- Stop if clients become authoritative over provider review actions.

## Result

Added evidence packages exposing capture refs, work-session refs, status/diff
summaries, validation summaries, and blocked reasons without client provider
authority.
