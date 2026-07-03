# 496 Planning Capture Publication Next Lane Checkpoint

Status: completed
Owner: Tom
Updated: 2026-07-02
Milestone: `../116-planning-projection-capture-publication-gate.md`

## Purpose

Choose the next lane after the planning projection capture publication gate.

## Candidate Lanes

- stopped publication/share runner handoff
- projection import/admission and semantic merge review
- guided planning session records
- task readiness linkage from promoted planning output

## Acceptance Criteria

- [x] Choice follows implementation evidence.
- [x] Next roadmap has ready cards or an explicit planning gap.

## Decision

Selected next lane:
`../117-planning-projection-import-admission.md`.

Reason:

- file export and capture publication/share gates are represented
- planning projection import remains blocked from active planning authority
  until admission and conflict staging exist
- semantic merge review is a planning-domain concern, not an SCM publication
  effect
- the next lane can add read-only scan, admission, conflict, and diagnostics
  records without applying files, creating active tasks, scheduling agents,
  running providers, or mutating SCM/forge state

Deferred:

- active planning mutation from imported projection files
- semantic merge resolution
- task seed promotion from imported files
- UI import flows
- provider, SCM, forge, callback, interruption, or recovery effects
