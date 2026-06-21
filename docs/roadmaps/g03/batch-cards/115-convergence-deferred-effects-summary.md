# 115 Convergence Deferred Effects Summary

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../034-convergence-exit-and-next-lane-selection.md`

## Purpose

Record the Convergence effects that remain intentionally deferred after the
stopped receipt control surface.

## Acceptance Criteria

- [x] Deferred local process effects are named.
- [x] Deferred remote/backend effects are named.
- [x] Deferred recovery/cancellation/retry effects are named.
- [x] No deferred effect becomes active work.

## Validation

- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
