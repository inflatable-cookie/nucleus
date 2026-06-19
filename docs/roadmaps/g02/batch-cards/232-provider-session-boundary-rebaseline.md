# 232 Provider Session Boundary Rebaseline

Status: planned
Owner: Tom
Updated: 2026-06-19
Milestone: `../053-harness-runtime-rebaseline.md`

## Purpose

Define the next provider session boundary before implementation resumes.

## Scope

- Recheck session identity, lifecycle, cancellation, recovery, and permission
  wait states.
- Keep bridged and native harness differences explicit.
- Do not widen client UI.

## Acceptance Criteria

- Provider session boundary is ready for one implementation lane.
- Capability differences remain visible.

## Validation

- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if provider runtime ownership is ambiguous.
