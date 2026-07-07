# 072 Selected Task Completion Route Control Surfaces

Status: planned
Owner: Tom
Updated: 2026-07-07
Milestone: `../015-selected-task-completion-from-route-admission.md`

## Purpose

Expose completion-from-route state through server control DTOs, `nucleusd`, and
Effigy.

## Work

- [ ] Add request/response DTOs for completion-from-route preview/apply evidence.
- [ ] Add `nucleusd` query or command output with focused rendering tests.
- [ ] Add an Effigy selector for the safe inspection path.
- [ ] Keep raw provider payloads and local desktop state out of the response.

## Acceptance Criteria

- [ ] CLI and Effigy show the same server-owned state.
- [ ] Query surfaces are read-only unless an explicit apply command is in scope.
- [ ] Output includes route, decision, evidence, receipt, and no-effect fields.
