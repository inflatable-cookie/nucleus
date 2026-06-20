# 377 Live Workflow Gap Index Closeout

Status: completed
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

- [x] Gap indexes match implemented runtime surfaces.
- [x] Remaining gaps are concrete.
- [x] No stale next-task pointer is left behind.
- [x] Docs QA passes.

## Result

Updated `docs/architecture/implementation-gap-index.md` with durable workflow
fixture, smoke dry-run, provider hardening, observability, and authority
regression evidence.

## Validation

- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
