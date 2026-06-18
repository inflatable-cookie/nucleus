# 127 Desktop Proof Surface Module Pressure Review

Status: completed
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

- [x] Desktop helper and style split targets are named.
- [x] Future task-agent panel work has a bounded location.
- [x] No final UI design work starts.

## Result

`apps/desktop/src/lib/control.ts` is now a small barrel over:

- `control/types.ts`
- `control/envelopes.ts`
- `control/responses.ts`
- `control/client.ts`

Future proof UI can import from `$lib/control` while keeping DTOs, envelope
builders, response readers, and Tauri invocation separate.

## Validation

- `effigy desktop:check`
- `effigy qa:docs`
- `git diff --check`

## Stop Conditions

- Stop if this requires product UI design decisions.
