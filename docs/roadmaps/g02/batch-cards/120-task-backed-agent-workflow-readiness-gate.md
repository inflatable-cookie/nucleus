# 120 Task Backed Agent Workflow Readiness Gate

Status: planned
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

- Readiness and blockers are explicit.
- Required contracts are named.
- No speculative runtime target is chosen.

## Validation

- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if first runtime target needs operator choice.
