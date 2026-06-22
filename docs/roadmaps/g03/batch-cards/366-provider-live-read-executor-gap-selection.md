# 366 Provider Live Read Executor Gap Selection

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../092-provider-live-read-smoke-closeout-and-executor-selection.md`

## Purpose

Select the next lane after the manual provider smoke.

## Acceptance Criteria

- [x] Options include server-owned live-read executor, product read-model
  consumption, stopped issue/comment/review fan-out, and credential repair.
- [x] Recommendation is based on what the smoke proved.
- [x] Selection does not grant provider writes or task mutation.

## Selection

Selected next lane: server-owned live-read executor.

Reason: the manual smoke proved local read access and sanitized evidence
capture. The remaining product gap is not more stopped fan-out or UI. It is a
repeatable server-owned read path that can use the admission, handoff,
response, and smoke approval records already modeled.

Deferred:

- visible UI expansion
- stopped issue/comment/review fan-out
- credential repair workflows
- provider writes
- task mutation
