# 110 Reassess First Desktop Panel Readiness

Status: done
Owner: Tom
Updated: 2026-06-17

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

- [x] First panel readiness is explicit.
- [x] If ready, the next panel card is narrow and shell-compatible.
- [x] If not ready, the blocker is routed to a server or desktop bootstrap card.

## Decision

The first desktop panel should be a control diagnostics panel.

Reasons:

- the desktop shell can already invoke one serialized Tauri command
- the server can answer read-only runtime metadata and state list queries
- project switcher and task list panels would be visually useful but thin until
  state mutation, project creation, task creation, and seed data flows exist
- terminal, browser, editor, and SCM panels still need their own authority and
  runtime contracts before implementation

## Next Panel Runway

- Add a control diagnostics panel that shows command-path health, protocol
  family/version, backend status, and last response/error.
- Keep it read-only and shell-compatible.
- Use it as the first UI surface for proving Rust-owned state access from the
  light TypeScript layer.
- Reassess project switcher readiness after diagnostics can issue more than one
  query shape cleanly.
