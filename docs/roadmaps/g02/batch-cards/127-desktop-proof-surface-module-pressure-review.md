# 127 Desktop Proof Surface Module Pressure Review

Status: planned
Owner: Tom
Updated: 2026-06-18
Milestone: `../029-health-and-module-boundary-reset.md`

## Purpose

Keep the disposable desktop proof shell from becoming a second authority
surface or a large TypeScript catch-all.

## Scope

- Review `apps/desktop/src/lib/control.ts` and `styles.css` pressure.
- Name helper splits needed before task-agent progress UI.
- Preserve Poodle/Svelte proof posture.

## Acceptance Criteria

- Desktop helper and style split targets are named.
- Future task-agent panel work has a bounded location.
- No final UI design work starts.

## Validation

- `effigy desktop:check`
- `effigy desktop:build`
- `effigy qa:docs`
- `git diff --check`

## Stop Conditions

- Stop if this requires product UI design decisions.
