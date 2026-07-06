# 009 Product Workflow SCM Next Composition

Status: planned
Owner: Tom
Updated: 2026-07-06
Milestone: `../002-product-workflow-source-composition.md`

## Purpose

Feed existing SCM readiness and known next-step records into the product
workflow summary.

## Work

- [ ] Locate existing SCM capture, review, change-request, and readiness
  records.
- [ ] Summarize SCM readiness refs without creating branches, commits,
  snapshots, pushes, publications, or change requests.
- [ ] Derive next-step source from known roadmap, task, goal, validation,
  planning, review, or workflow evidence.
- [ ] Keep blocked next-step reasons explicit when no source exists.
- [ ] Add focused tests for SCM-ready, SCM-missing, next-ready, and
  next-blocked states.

## Acceptance Criteria

- [ ] SCM readiness is visible when existing records support it.
- [ ] Next step comes from a known pathway, not a fabricated action.
- [ ] No SCM, forge, task, provider, or UI mutation is introduced.
