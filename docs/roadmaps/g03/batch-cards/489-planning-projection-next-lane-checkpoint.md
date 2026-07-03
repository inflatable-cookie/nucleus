# 489 Planning Projection Next Lane Checkpoint

Status: completed
Owner: Tom
Updated: 2026-07-02
Milestone: `../115-planning-projection-file-export-capture.md`

## Purpose

Choose the next lane after planning projection file export and capture prep.

## Candidate Lanes

- projection import/admission and merge review
- management-capture publication/share boundary
- guided planning session records
- task readiness linkage from promoted planning output

## Acceptance Criteria

- [x] Choice follows implementation evidence.
- [x] Next roadmap has ready cards or an explicit planning gap.

## Decision

Selected next lane:
`../116-planning-projection-capture-publication-gate.md`.

Reason:

- file export and capture prep are implemented
- capture prep already produces sanitized evidence refs
- G03 is still an effect-gated SCM/publication generation
- capture publication can be modeled as explicit authority and stopped
  publication planning before any SCM, forge, provider, or UI effect

Deferred:

- projection import/admission
- semantic merge review
- planning session depth
- task readiness linkage from promoted planning output
