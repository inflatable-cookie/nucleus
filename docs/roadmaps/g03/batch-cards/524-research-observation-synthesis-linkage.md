# 524 Research Observation Synthesis Linkage

Status: completed
Owner: Tom
Updated: 2026-07-03
Milestone: `../120-deep-research-run-brief-foundation.md`

## Purpose

Represent observations, synthesis refs, and promotion target refs.

## Work

- [x] Add observation refs for extracted claims/findings tied to source refs.
- [x] Add synthesis refs for answer, recommendation, decision support, planning
  input, and task seed group outputs.
- [x] Add memory proposal refs, planning artifact refs, task seed refs, and
  source evidence refs as refs only.

## Acceptance Criteria

- [x] Observations distinguish evidence, inference, speculation, and
  recommendation.
- [x] Synthesis is linked by refs only.
- [x] No accepted memory, planning artifact, task seed, projection, or docs
  mutation is added.

## Evidence

- `cargo test -p nucleus-research`
