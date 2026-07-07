# 033 Selected Task Command CLI Effigy

Status: completed
Owner: Tom
Updated: 2026-07-06
Milestone: `../007-selected-task-command-admission-controls.md`

## Purpose

Expose selected-task command admission through `nucleusd` and Effigy for
inspection and narrow operator-triggered task mutation.

## Work

- [x] Add a `nucleusd` command surface for admitted task-only actions.
- [x] Require expected revision where available.
- [x] Require a reason for block.
- [x] Add an Effigy selector for a safe inspection or dry-run shape before any
  mutating selector.
- [x] Add focused CLI tests.

## Acceptance Criteria

- [x] CLI output distinguishes dry-run/admission evidence from mutation.
- [x] Any mutating path requires explicit operator command invocation.
- [x] No provider, SCM, delegation, review, memory, or planning mutation is
  introduced.

## Result

- Added `selected-task-command-admission` as a server query and `nucleusd`
  typed dry-run renderer.
- Added `server:query:selected-task-command-admission` as a safe Effigy
  inspection selector.
- Kept task mutation out of this query path; admitted commands are previews,
  not executed receipts.
