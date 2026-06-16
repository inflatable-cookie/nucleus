# 113 Reassess Project Switcher Readiness

Status: done
Owner: Tom
Updated: 2026-06-17

## Goal

Decide whether the project switcher should follow diagnostics or whether a
server mutation/seed-data card must come first.

## Scope

- Check diagnostics panel query coverage.
- Check server project list behavior.
- Check whether the desktop can show useful empty/project states.
- Decide the next implementation card.

## Out Of Scope

- Implementing project switcher.
- Implementing project creation.
- Implementing task panels.

## Promotion Targets

- `docs/roadmaps/g01/012-desktop-control-diagnostics-and-panel-foundation.md`
- `docs/roadmaps/g01/batch-cards/README.md`

## Acceptance Criteria

- [x] Project switcher readiness is explicit.
- [x] If ready, the next card is scoped to a read-only project switcher.
- [x] If not ready, the blocker is routed to server mutation or fixture/seed data.

## Decision

Project switcher is not ready yet.

Reasons:

- diagnostics can issue project list queries, but returned project records are
  opaque storage envelopes
- the server does not execute project state mutation commands yet
- the desktop has no project creation, seed, import, or repair flow
- project display fields are defined in `nucleus-projects`, but there is no
  control DTO or storage codec that exposes them safely to the desktop

## Routed Blocker

Add a project state record and mutation runway before building the switcher.

The next lane should define how project records become display-ready control
DTOs, how local project creation or seed data enters storage, and when the
desktop can render a useful empty/project state.
