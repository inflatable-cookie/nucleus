# 158 Desktop Task Agent Progress Validation

Status: planned
Owner: Tom
Updated: 2026-06-18
Milestone: `../035-desktop-task-agent-progress-proof.md`

## Purpose

Validate the desktop task-agent progress proof surface.

## Scope

- Run desktop, server, docs, and workspace checks.
- Confirm panel remains read-only.
- Advance to workflow validation and next-lane selection.

## Acceptance Criteria

- Desktop proof cards are complete or rehomed.
- Read-only posture is preserved.
- Next ready card points to workflow validation.

## Validation

- `effigy desktop:check`
- `effigy desktop:build`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if UI becomes product design work.
