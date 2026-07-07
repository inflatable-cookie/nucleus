# 042 Selected Task Review Next CLI Effigy

Status: completed
Owner: Tom
Updated: 2026-07-07
Milestone: `../009-selected-task-review-next-step-presentation.md`

## Purpose

Expose selected-task review/next-step presentation through inspection surfaces.

## Work

- [x] Add serialized control DTOs for the read-only query/result.
- [x] Add `nucleusd query` inspection.
- [x] Add an Effigy selector.
- [x] Add focused codec and CLI rendering tests.

## Acceptance Criteria

- [x] CLI/Effigy output is sanitized and read-only.
- [x] Unsupported, empty, and error responses are explicit.
- [x] No review, task, provider, SCM/forge, memory, or planning mutation command
  is added.

## Result

- Added selected-task review/next query control DTOs, response DTOs, request
  handling, `nucleusd query selected-task-review-next`, and the matching
  Effigy selector.
- Added sanitized CLI rendering for review state, evidence counts, source
  counts, gaps, next-step category, and no-effect flags.
- Added focused request/response codec tests, CLI parse coverage, and
  typed-rendering coverage.
