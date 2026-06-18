# 120 Task Backed Agent Workflow Readiness Gate

Status: completed
Owner: Tom
Updated: 2026-06-18
Milestone: `../028-next-product-workflow-selection.md`

## Purpose

Assess readiness for a task-backed agent workflow proof.

## Scope

- Review task command, work-item, timeline, receipt, and provider runtime
  surfaces.
- Identify missing gates.
- Do not implement provider execution.

## Acceptance Criteria

- [x] Readiness and blockers are explicit.
- [x] Required contracts are named.
- [x] No speculative runtime target is chosen.

## Outcome

Task-backed agent work is the engineering default recommendation, but it still
requires a first runtime target decision before implementation starts.

## Validation

- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if first runtime target needs operator choice.
