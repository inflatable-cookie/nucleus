# 056 Shell Switch Epoch And Context Isolation

Status: completed
Owner: Tom
Created: 2026-08-03
Milestone: `../019-shell-context-cohesion.md`
Depends on: card 055
Auto-start next card: yes

## Objective

Make project selection a hard workspace-renderer epoch and prevent stale panel
or command context from leaking through the transition.

## Acceptance

- [x] the previous project stage unmounts at selection change
- [x] launcher panel kinds clear until the selected project snapshot arrives
- [x] active-panel command context clears during the same boundary
- [x] stale session publications remain unable to replace the selected layout

## Validation

- [x] focused desktop fixtures pass
- [x] desktop type checking and diff hygiene pass

## Stop Conditions

- do not move per-project layout authority into renderer state
- do not add a layout reset or repair command

## Evidence

`App.svelte` keys the workspace stage by selected project and clears launcher
and active-panel facts at the same boundary. The existing session fixture
proves listener teardown, clean remount, and stale mutation rejection.
