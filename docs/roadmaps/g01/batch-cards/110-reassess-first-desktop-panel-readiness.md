# 110 Reassess First Desktop Panel Readiness

Status: planned
Owner: Tom
Updated: 2026-06-16

## Goal

Decide which desktop panel, if any, should follow shell bootstrap.

## Scope

- Check shell command-path proof.
- Check server state/query coverage.
- Decide between project switcher, task list, or transport diagnostics.
- Keep terminal/browser/editor/SCM panel sequencing explicit.

## Out Of Scope

- Implementing panels.
- Implementing live subscriptions.
- Implementing provider processes.

## Promotion Targets

- `apps/desktop/README.md`
- `docs/roadmaps/g01/README.md`
- `docs/roadmaps/g01/batch-cards/README.md`

## Acceptance Criteria

- First panel readiness is explicit.
- If ready, the next panel card is narrow and shell-compatible.
- If not ready, the blocker is routed to a server or desktop bootstrap card.
