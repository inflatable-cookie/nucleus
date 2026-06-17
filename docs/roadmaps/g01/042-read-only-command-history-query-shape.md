# 042 Read-Only Command History Query Shape

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Improve command evidence and read-only command history query shape before
desktop command controls.

## Scope

- Define command history fields safe for clients.
- Add a query path that returns sanitized command evidence summaries.
- Keep raw output unavailable.
- Preserve the existing command evidence storage records.
- Decide whether desktop command diagnostics are ready after this lane.

## Out Of Scope

- Desktop UI implementation.
- Raw artifact payload retrieval.
- Write-enabled commands.
- PTY or streaming output.

## Decisions

- Desktop controls need a list/detail history shape before UI work.
- Existing command evidence records are the persistence base.
- The query surface should return sanitized evidence summaries, not raw storage
  records.

## Execution Plan

- [x] Define read-only command history DTO shape.
- [x] Add sanitized command evidence list response.
- [x] Add `nucleusd` command history query printing.
- [x] Add tests proving raw output remains absent.
- [x] Reassess desktop command diagnostics readiness.

## Acceptance Criteria

- Clients can query sanitized command run history.
- Raw stdout/stderr remain absent.
- Existing evidence storage remains compatible.
- Desktop readiness is explicit.

## Cards

- `docs/roadmaps/g01/batch-cards/241-define-command-history-dto-shape.md`
- `docs/roadmaps/g01/batch-cards/242-add-sanitized-command-evidence-list-response.md`
- `docs/roadmaps/g01/batch-cards/243-add-nucleusd-command-history-query-output.md`
- `docs/roadmaps/g01/batch-cards/244-test-command-history-raw-output-absence.md`
- `docs/roadmaps/g01/batch-cards/245-reassess-desktop-command-diagnostics-readiness.md`

## Outcome

The control response DTO now exposes `command_evidence_records` for command
history. `nucleusd query command-evidence` renders that DTO instead of
decoding storage records locally.

Desktop command diagnostics are ready for read-model planning. The UI should
still stay read-only and disposable until artifact resolution, streaming, and
write-enabled command policy are separately contracted.
