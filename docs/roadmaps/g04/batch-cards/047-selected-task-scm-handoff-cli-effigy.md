# 047 Selected Task SCM Handoff CLI Effigy

Status: completed
Owner: Tom
Updated: 2026-07-07
Milestone: `../010-selected-task-scm-handoff-readiness.md`

## Purpose

Expose selected-task SCM handoff readiness through inspection surfaces.

## Work

- [x] Add serialized control DTOs for the read-only query/result.
- [x] Add `nucleusd query` inspection.
- [x] Add an Effigy selector.
- [x] Add focused codec and CLI rendering tests.

## Acceptance Criteria

- [x] CLI/Effigy output is sanitized and read-only.
- [x] Unsupported, empty, and error responses are explicit.
- [x] No SCM, forge, credential, task, provider, review, memory, planning, or
  UI mutation command is added.

## Result

- Added a selected-task SCM handoff query/result to the server control API and
  serialized control DTOs.
- Added `nucleusd query selected-task-scm-handoff --project <id> --task <id>`.
- Added `effigy server:query:selected-task-scm-handoff`.
- Added focused request/response codec, CLI parse, and typed renderer tests.
- Split selected-task query parsing and the new CLI parse test out of files
  that crossed the god-file hard threshold.
