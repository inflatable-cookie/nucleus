# 055 Task Delegation Command Admission

Status: completed
Owner: Tom
Updated: 2026-06-17
Milestone: `../015-task-backed-agent-work-unit-proof.md`

## Purpose

Admit the first task-to-agent delegation command through the engine boundary.

## Scope

- Add command vocabulary for operator-controlled task delegation.
- Validate task id, adapter/session target, and idempotency posture.
- Return command receipts without starting autonomous execution.
- Keep scheduling and model selection minimal.

## Acceptance Criteria

- [x] Task delegation can be accepted or rejected through typed command
  admission.
- [x] Rejected delegation does not mutate task or runtime projections.
- [x] Accepted delegation creates or references one work item.
- [x] Provider completion still does not imply task acceptance.

## Outcome

- Added a typed task delegation command to the engine and server command
  vocabulary.
- Delegation validates task id, adapter id, provider instance id, revision, and
  idempotency key.
- Accepted delegation produces a scheduled work item and a runtime scheduling
  receipt posture without starting a provider.
- The control DTO explicitly rejects delegation until the wire shape is
  designed.

## Validation

- [x] `cargo test -p nucleus-engine task`
- [x] `cargo test -p nucleus-server task`
- [x] `cargo check --workspace`
- [x] `effigy qa:docs`
- [x] `effigy qa:northstar`
- [x] `rg -n '^## Next Task' README.md AGENTS.md docs`
- [x] `git diff --check`

## Stop Conditions

- Stop if delegation requires unresolved scheduler or model-route policy.
