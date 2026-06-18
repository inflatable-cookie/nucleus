# 156 Desktop Task Work Wait State Display

Status: planned
Owner: Tom
Updated: 2026-06-18
Milestone: `../035-desktop-task-agent-progress-proof.md`

## Purpose

Display task work-unit wait states without granting approval authority.

## Scope

- Render approval, user-input, timeout, and cancellation waits.
- Keep approval action buttons absent.
- Preserve source refs in detail rows.

## Acceptance Criteria

- Wait states are visible and distinct.
- Client cannot approve or resume work from this panel.
- Source refs remain inspectable.

## Validation

- `effigy desktop:check`
- `effigy desktop:build`
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if approval UX needs product design.
