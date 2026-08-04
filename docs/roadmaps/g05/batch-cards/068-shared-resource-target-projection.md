# 068 Shared Resource Target Projection

Status: completed
Owner: Tom
Created: 2026-08-04
Milestone: `../022-terminal-browser-resource-host-cohesion.md`
Depends on: card 067
Auto-start next card: yes

## Objective

Use one tested effective-target projection for both compact panel chrome and
the resource id passed to Agent Chat, Editor, and Terminal.

## Acceptance

- [x] default, sole-resource, explicit, ambiguous, and broken cases are shared
- [x] visible selection and host request cannot diverge
- [x] target changes remain project- and panel-scoped across restart
- [x] unavailable explicit targets remain visible for repair and never fall back

## Validation

- [x] focused Bun target fixtures and desktop checking pass

## Stop Conditions

- do not move durable target state into Svelte component state
- do not choose a resource by list order

## Evidence

`effectiveResourceTarget` now owns the exact default, sole, explicit,
ambiguous, and broken-target projection used by both compact chrome and panel
host requests. Five focused Bun fixtures and desktop checking pass. The sole
Svelte warning remains the pre-existing ProjectRail pointerdown warning.
