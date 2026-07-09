# 116 Product Workflow UI Design Review

Status: completed
Owner: Tom
Updated: 2026-07-09
Milestone: `../024-workspace-surface-shell-skeleton.md`

## Purpose

Review the running surface shell before adding real workflow panels.

## Work

- [x] Run the desktop app.
- [x] Confirm surface create/rename/remove behavior.
- [x] Confirm the four-region layout feels like the right base.
- [x] Decide the first real panel workflow: agent chat shell, panel tabs,
  task system tab behavior, terminal/editor placeholder, or settings.

## Acceptance Criteria

- [x] The next UI lane is selected by operator design direction.
- [x] The next lane does not add speculative workflow noise.

## Decision

Keep the approved surface shell and panel placement behavior intact.

Implement the first real workflow inside the existing `Agent Chat` panel.
Tasks remain a separate follow-on after the chat interaction is usable.
