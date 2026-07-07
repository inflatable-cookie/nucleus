# 058 Selected Task Review Decision Desktop Proof

Status: completed
Owner: Tom
Updated: 2026-07-07
Milestone: `../012-selected-task-review-decision-controls.md`

## Purpose

Add disposable desktop proof controls for review decisions without making the
client authoritative.

## Work

- [x] Add light TypeScript client bindings for review-decision admission/apply.
- [x] Show allowed/blocked decision state in the selected-task proof panel.
- [x] Add controls for accept, request changes, reject, and abandon where the
  server says the action is available.
- [x] Show receipts, stale-client errors, and no-effect flags.

## Acceptance Criteria

- [x] Desktop controls call the server boundary and do not mutate local review
  state directly.
- [x] Stale or blocked decisions are visible and recoverable.
- [x] The proof remains disposable and does not start final panel/layout work.
- [x] Guard tests prevent accidental provider, SCM, memory, planning, or direct
  client mutation authority.

## Result

- Added desktop control bindings for selected-task review-decision admission
  and apply.
- Added disposable review-decision controls to the selected-task workflow proof
  panel.
- Gated apply buttons on server admission state instead of client-local review
  state.
- Added proof rendering for decision receipts, blockers, and no-effect flags.
- Extended panel guard tests for server-boundary use and forbidden authority.
