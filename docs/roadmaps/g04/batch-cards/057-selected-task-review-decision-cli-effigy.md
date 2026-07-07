# 057 Selected Task Review Decision CLI Effigy

Status: completed
Owner: Tom
Updated: 2026-07-07
Milestone: `../012-selected-task-review-decision-controls.md`

## Purpose

Expose review-decision admission and apply paths through the server control
surface, `nucleusd`, and Effigy.

## Work

- [x] Add control DTOs for review-decision admission/apply.
- [x] Add `nucleusd` query or command surfaces for dry-run and explicit apply.
- [x] Add Effigy selectors for inspection and safe smoke validation.
- [x] Add focused serialization and CLI rendering tests.

## Acceptance Criteria

- [x] CLI and Effigy use the same server boundary as the engine.
- [x] Dry-run output is useful before apply.
- [x] Apply requires explicit operator-provided decision fields.
- [x] Output remains sanitized and does not expose raw provider/command
  payloads.

## Result

- Added server query shapes and DTOs for selected-task review-decision
  admission and explicit apply.
- Added `nucleusd query selected-task-review-decision-admission` and
  `nucleusd query selected-task-review-decision-apply`.
- Added Effigy selectors:
  `server:query:selected-task-review-decision-admission` and
  `server:query:selected-task-review-decision-apply:blocked-smoke`.
- Added focused request/response DTO tests and CLI typed-response rendering
  tests.
