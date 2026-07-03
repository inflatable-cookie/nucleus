# 116 Planning Projection Capture Publication Gate

Status: completed
Owner: Tom
Updated: 2026-07-02

## Purpose

Add an explicit publication/share gate for prepared planning projection
management captures.

Roadmap `115` can materialize reviewed planning projection files and prepare
capture evidence without SCM or forge effects. This lane turns that prepared
capture into an admitted publication/share request shape, with stopped-by-
default evidence and diagnostics. It does not create commits, snapshots, pushes,
publications, forge requests, imports, active planning mutations, task
promotions, provider execution, or UI behavior.

## Governing Refs

- `docs/contracts/008-storage-state-persistence-contract.md`
- `docs/contracts/012-native-harness-runtime-contract.md`
- `docs/contracts/014-structured-project-planning-contract.md`
- `docs/architecture/planning-management-projection-shape.md`
- `docs/roadmaps/g03/115-planning-projection-file-export-capture.md`

## Goals

- [x] Select the adapter-neutral capture publication authority boundary.
- [x] Represent publication/share admission from prepared management capture
  evidence.
- [x] Preserve SCM-family differences: commit, snapshot, publish, push, forge
  share, or future adapter equivalent are not assumed to be the same effect.
- [x] Persist stopped publication/share request and diagnostic records without
  performing the effect.
- [x] Expose sanitized read-only inspection for publication readiness.
- [x] Keep projection import/admission, merge policy, active planning mutation,
  task promotion, provider execution, and UI out of scope.

## Execution Plan

- [x] Batch 1: select publication/share gate vocabulary and blocked effects.
- [x] Batch 2: add admission records from prepared management capture evidence.
- [x] Batch 3: add stopped publication/share request and no-effect diagnostics.
- [x] Batch 4: expose read-only control/CLI inspection if the server surface
  exists.
- [x] Batch 5: choose the next lane: stopped runner handoff, projection
  import/admission, or planning-session depth.

## Batch Cards

Ready cards:

- None.

Planned cards:

- None.

Completed cards:

- `batch-cards/496-planning-capture-publication-next-lane-checkpoint.md`
- `batch-cards/495-planning-capture-publication-validation.md`
- `batch-cards/494-planning-capture-publication-cli-effigy.md`
- `batch-cards/493-planning-capture-publication-diagnostics.md`
- `batch-cards/492-planning-capture-publication-stopped-request.md`
- `batch-cards/491-planning-capture-publication-admission-records.md`
- `batch-cards/490-planning-capture-publication-boundary-selection.md`

## Acceptance Criteria

- [x] Publication/share requests can cite prepared planning projection capture
  evidence.
- [x] Admission distinguishes adapter families and does not collapse all SCMs
  into Git commit semantics.
- [x] Missing approval, unsupported adapter family, unresolved export issues,
  unsafe refs, and non-management file refs are blocked as controlled records.
- [x] Stopped requests carry sanitized evidence refs and no-effect flags.
- [x] No commit, snapshot, push, publish, forge mutation, provider execution,
  projection import, active planning mutation, task promotion, or UI behavior
  is added.

## Stop Conditions

- The work requires executing a real SCM, forge, or provider operation.
- The work requires treating Git commits as the universal publication model.
- The work requires applying projected files into active planning authority.
- The work requires resolving semantic merge conflicts.
- The work requires UI behavior or raw payload retention.

## Next Lane

Selected: `117-planning-projection-import-admission.md`.

Reason: roadmap `116` proved the stopped publication/share gate over prepared
management capture evidence without SCM, forge, provider, or UI effects. The
remaining planning-projection gap is import/admission: reading projected
planning files back into server-controlled review records, staging conflicts,
and exposing diagnostics without making projected files active planning
authority.
