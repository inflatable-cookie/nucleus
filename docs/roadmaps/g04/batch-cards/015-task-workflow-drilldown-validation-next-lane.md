# 015 Task Workflow Drilldown Validation Next Lane

Status: completed
Owner: Tom
Updated: 2026-07-06
Milestone: `../003-task-workflow-drilldown-and-handoff-readiness.md`

## Purpose

Validate the task workflow drilldown lane and choose the next bounded product
lane.

## Work

- [x] Run focused server, CLI, Effigy, and desktop drilldown checks.
- [x] Run docs QA, Northstar QA, format/diff checks, package checks, and
  doctor.
- [x] Compare remaining gaps against `docs/roadmaps/deferred-lanes.md`.
- [x] Choose the next lane from review/SCM handoff, task-backed agent loop
  hardening, planning/research UX, memory review UX, or client workflow
  composition.

## Acceptance Criteria

- [x] Validation passes or failures are documented.
- [x] Remaining gaps are product-significant, not invented busywork.
- [x] The next lane is bounded and does not reopen deferred subsystem work by
  default.

## Result

Validation passed for the server read model, control DTOs, `nucleusd` query,
Effigy selector, disposable desktop proof, docs QA, Northstar QA, formatting,
diff whitespace, Svelte check, and doctor.

Doctor remains green with the expected god-file warning baseline:

- warnings: 185
- errors: 0

The next lane is selected-task work-loop composition. It should make the
visible path from selected task to readiness, work evidence, review, SCM
handoff, and next action coherent without reopening deferred active-apply,
provider live-read, Convergence execution, provider execution, or SCM mutation
lanes.
