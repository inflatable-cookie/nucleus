# 045 Selected Task SCM Handoff Boundary

Status: completed
Owner: Tom
Updated: 2026-07-07
Milestone: `../010-selected-task-scm-handoff-readiness.md`

## Purpose

Define the read-only boundary for selected-task SCM handoff readiness.

## Work

- [x] Name the source records allowed in the handoff readiness model.
- [x] Define readiness states and provider-neutral target shapes.
- [x] Define no-effect flags for SCM, forge, credential, task, provider,
  review, memory, planning, and UI effects.
- [x] Record stop conditions before server or desktop code changes.

## Acceptance Criteria

- [x] The lane can proceed without creating SCM/forge mutation controls.
- [x] Git-specific and Convergence-style handoff shapes both fit the wording.
- [x] Handoff readiness stays separate from publication, review acceptance, and
  task completion.

## Result

- Allowed sources are selected task identity, task workflow drilldown refs,
  task work-item refs, SCM handoff refs, engine SCM work-item linkage refs,
  provider-neutral change refs, SCM work-session refs, checkpoint refs, diff
  summary refs, runtime receipt refs, validation refs, change-request prep refs,
  and product workflow SCM readiness refs/gaps.
- Readiness states are missing, blocked, evidence-ready, prep-ready,
  publication-pending, represented, and repair-required.
- Provider-neutral target shapes are forge review, provider publication,
  provider gate, direct authority update, manual handoff, custom provider
  value, and unknown.
- No-effect flags cover SCM mutation, forge mutation, credential resolution,
  task mutation, provider execution, review mutation, memory apply, planning
  apply, projection write, and UI effect.
- Git-specific commit/branch/PR language and Convergence-style
  snapshot/publication/gate language are adapter mappings, not universal
  requirements.
