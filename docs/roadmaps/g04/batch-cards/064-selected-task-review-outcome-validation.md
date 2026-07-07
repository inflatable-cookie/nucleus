# 064 Selected Task Review Outcome Validation

Status: planned
Owner: Tom
Updated: 2026-07-07
Milestone: `../013-selected-task-review-outcome-routing.md`

## Purpose

Validate the review outcome-routing lane and select the next product phase.

## Work

- [ ] Run focused server, CLI, Effigy, desktop, docs, and Northstar validation.
- [ ] Confirm route readiness is read-only and consistent across surfaces.
- [ ] Confirm no forbidden task lifecycle, provider, SCM, memory, planning, or
  final UI effects were added.
- [ ] Decide whether the next phase is task lifecycle admission,
  rework/delegation routing, SCM handoff review, or a planning checkpoint.

## Acceptance Criteria

- [ ] Review outcome routes work through the same boundary across server, CLI,
  Effigy, and desktop proof.
- [ ] Validation passes or failures are recorded with clear remediation.
- [ ] The next task points to a ready card or explicit planning checkpoint.
