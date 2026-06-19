# 279 Provider Runtime Orchestration Linkage

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../062-provider-runtime-materialisation-gate.md`

## Purpose

Link provider-service outcomes to orchestration/runtime receipt vocabulary
without task mutation.

## Scope

- Represent provider command outcomes as runtime receipts/events.
- Name projection-readiness gaps before task mutation.
- Keep provider observations from changing task state.

## Acceptance Criteria

- Provider-service outcomes can be inspected through existing receipt/event
  concepts.
- Task mutation remains blocked.
- Follow-up task-state mutation gate has explicit prerequisites.

## Validation

- [x] targeted engine/server tests
- [x] `cargo check --workspace`
- [x] `git diff --check`

## Stop Conditions

- Stop if orchestration linkage needs a contract change.

## Result

Added provider runtime outcome records that map service-owned provider work to
existing `HarnessProvider` runtime receipts and runtime observation event-store
records.

Projection readiness now records the explicit gaps that keep provider
observations from mutating task state: task mutation gate selection, provider
observation projection rules, task work-item linkage, and human review policy.
