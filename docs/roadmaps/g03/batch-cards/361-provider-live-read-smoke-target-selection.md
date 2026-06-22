# 361 Provider Live Read Smoke Target Selection

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../090-provider-live-read-smoke-approval-gate.md`

## Purpose

Select the first concrete live-read smoke target without executing it.

## Acceptance Criteria

- [x] Provider, repo scope, operation family, and target refs are named.
- [x] The target is read-only and does not require provider writes.
- [x] Required local evidence refs are named.
- [x] Selection does not grant credential or network authority.
