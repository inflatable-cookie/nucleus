# Shared Work Context

Date: 2026-08-03
Status: completed

## Outcome

Each project now retains one local working context: selected Goal, selected
Task, and active conversation. Each Agent Chat panel may retain its own
conversation attachment. Both live in the existing panel-presentation domain;
neither mutates the server-owned Goal, Task, or conversation models.

The workspace stage now owns the authoritative project work projection. Tasks,
Agent Chat composer attachments, and Diff consume the same resolved records.
Closing Tasks no longer erases focus. Projects and Threads share the active
conversation id, and opening a thread activates or creates an Agent Chat panel
with that attachment.

The close path also repaired a stale shell fact: closing the sole Tasks panel
now immediately re-enables its header launcher.

## Evidence

- focused workspace Rust tests: 11 pass
- desktop tests: 39 Bun tests and 18 Vitest tests pass
- desktop type check: zero errors; one pre-existing ProjectRail accessibility warning
- Doctor returned to the 25 pre-existing oversized-file errors after the new
  workspace persistence tests were split into a focused module
- fresh fixture-backed native bundle: Task focus reached Agent Chat, survived
  project switching, Tasks closure, full app restart, and Tasks reopening
- authenticated provider work: not run

## Boundary

Working context remains advisory presentation state. It grants no Goal or Task
mutation, assignment, execution, review, or provider authority. Provider-backed
thread creation was not needed for this acceptance; conversation attachment,
project isolation, and restart are covered by deterministic fixtures.

## Next

Operator checkpoint. Use the consolidated context, then select the next g05
inward lane.
