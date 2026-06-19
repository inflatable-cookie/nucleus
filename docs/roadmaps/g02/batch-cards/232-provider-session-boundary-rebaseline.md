# 232 Provider Session Boundary Rebaseline

Status: completed
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

## Result

The next provider session boundary is durable Codex session binding plus
accepted-event persistence. Provider callback responses, cancellation,
resume/recovery execution, and automatic task mutation stay gated.

## Validation

- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if provider runtime ownership is ambiguous.
