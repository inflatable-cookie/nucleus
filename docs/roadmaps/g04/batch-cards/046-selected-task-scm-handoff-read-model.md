# 046 Selected Task SCM Handoff Read Model

Status: completed
Owner: Tom
Updated: 2026-07-07
Milestone: `../010-selected-task-scm-handoff-readiness.md`

## Purpose

Build a server-owned read model for selected-task SCM handoff readiness.

## Work

- [x] Compose handoff readiness from existing task workflow, SCM handoff,
  checkpoint, diff, runtime receipt, review, and change-request prep refs.
- [x] Surface provider-neutral target shape, readiness state, evidence counts,
  blockers, and next-step category.
- [x] Prove no SCM/forge, credential, task, provider, review, memory,
  planning, projection, or UI mutation occurs.
- [x] Add focused server tests for ready, missing, blocked, and neutral target
  shapes.

## Acceptance Criteria

- [x] Handoff readiness is deterministic from server-owned evidence.
- [x] Missing evidence and repair-needed states are explicit.
- [x] No provider-specific workflow is treated as universal.

## Result

- Added a pure `selected_task_scm_handoff` server read model with small modules
  for types, evidence, readiness, next-step selection, and construction.
- The model derives missing, blocked, evidence-ready, prep-ready,
  publication-pending, represented, and repair-required states from existing
  task workflow refs.
- It keeps provider-neutral target shapes separate from adapter-specific Git
  or Convergence semantics.
- It exposes no-effect flags for SCM, forge, credentials, task, provider,
  review, memory, planning, projection, and UI effects.
- Focused tests cover missing handoff refs, blocked evidence, Git-like prep,
  Convergence-like publication, and superseded/repair refs.
