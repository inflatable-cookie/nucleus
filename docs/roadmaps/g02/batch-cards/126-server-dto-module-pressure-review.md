# 126 Server DTO Module Pressure Review

Status: planned
Owner: Tom
Updated: 2026-06-18
Milestone: `../029-health-and-module-boundary-reset.md`

## Purpose

Prevent the next runtime lane from expanding already-large server DTO and
request-handler files.

## Scope

- Review current warning-sized server files.
- Name files that must split before accepting task-agent DTO growth.
- Add planning notes only unless a small split is clearly mechanical.

## Acceptance Criteria

- Server pressure points are named.
- Task-agent DTO work has a target module location.
- No runtime behavior is added.

## Validation

- `effigy doctor`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if this turns into broad server refactoring.
