# 490 Planning Capture Publication Boundary Selection

Status: completed
Owner: Tom
Updated: 2026-07-02
Milestone: `../116-planning-projection-capture-publication-gate.md`

## Purpose

Select the first adapter-neutral boundary for publishing or sharing prepared
planning projection management captures.

## Work

- [x] Audit existing SCM capture and change-request authority records.
- [x] Identify the minimal publication/share vocabulary needed for planning
  projection captures.
- [x] Separate adapter family terms: commit, snapshot, publish, push, forge
  share, and future equivalents.
- [x] Name blocked effects and required evidence refs.

## Acceptance Criteria

- [x] The selected boundary follows roadmap `115` evidence.
- [x] The selected vocabulary does not assume Git commit semantics.
- [x] The next implementation card has bounded type changes.
- [x] Real SCM/forge/provider execution remains out of scope.

## Decision

The first boundary is a planning-capture publication admission over persisted
management-capture preparation records.

Vocabulary:

- adapter family: Git-like, snapshot/publication-like, forge-review-like,
  manual, or custom
- operation: commit, snapshot, publish, push, forge share, manual share, or
  custom
- admitted authority: creation of a stopped request only

Required evidence:

- persisted management-capture preparation record
- ready preparation plan
- sanitized planning projection file-write evidence refs
- approval ref
- scoped planning management file refs under `nucleus/planning/`

Blocked effects:

- SCM or snapshot mutation
- remote share
- forge mutation
- provider write
- projection import
- task promotion
- callback, interruption, and recovery execution
- raw payload retention
