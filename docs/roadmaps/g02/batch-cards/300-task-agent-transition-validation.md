# 300 Task Agent Transition Validation

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../066-task-backed-workflow-hardening.md`

## Purpose

Add explicit validation for task-agent work-unit runtime and review source
record transitions.

## Scope

- Define allowed runtime transitions for task-agent work-unit source records.
- Define allowed review transitions separately from runtime transitions.
- Reject source records that skip required review or evidence states.
- Preserve recovery, cancellation, and failure states without pretending they
  complete task work.
- Add focused tests for valid and invalid transition chains.

## Acceptance Criteria

- [x] Runtime transitions reject impossible jumps.
- [x] Review transitions reject impossible jumps.
- [x] Recovery/failure/cancellation remain terminal or repair-gated as
      specified.
- [x] Transition validation runs before durable source-record writes.
- [x] Existing persisted source-record and query tests still pass.

## Validation

- targeted `nucleus-server` transition tests
- `cargo check --workspace`

## Stop Conditions

- Stop if the contract lacks enough detail to decide a transition rule.
