# 377 Live Workflow Gap Index Closeout

Status: planned
Owner: Tom
Updated: 2026-06-20
Milestone: `../082-task-backed-live-workflow-closeout.md`

## Purpose

Update architecture and implementation gap indexes from live workflow evidence.

## Scope

- Promote completed runtime surfaces to current state.
- Remove stale missing items.
- Record remaining blockers and next lanes.

## Acceptance Criteria

- [ ] Gap indexes match implemented runtime surfaces.
- [ ] Remaining gaps are concrete.
- [ ] No stale next-task pointer is left behind.
- [ ] Docs QA passes.

## Validation

- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
