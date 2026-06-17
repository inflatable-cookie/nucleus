# 263 Wire Readiness Panel Into Desktop Shell

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Place the runtime readiness panel in the disposable desktop shell.

## Scope

- Add panel import and layout placement.
- Keep responsive panel sizing stable.
- Avoid changing task/project command behavior.

## Out Of Scope

- Final UI composition.
- Navigation redesign.

## Promotion Targets

- `apps/desktop/src/App.svelte`
- `apps/desktop/src/styles.css`

## Acceptance Criteria

- The shell renders readiness diagnostics beside existing proof panels.
- Existing project, task, control, and command diagnostics panels keep working.

## Outcome

Wired `RuntimeReadinessPanel` into the disposable desktop shell without
changing project, task, command history, or control diagnostics behavior.
