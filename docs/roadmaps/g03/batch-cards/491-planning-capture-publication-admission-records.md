# 491 Planning Capture Publication Admission Records

Status: completed
Owner: Tom
Updated: 2026-07-02
Milestone: `../116-planning-projection-capture-publication-gate.md`

## Purpose

Add admission records for publication/share requests created from prepared
planning projection capture evidence.

## Work

- [x] Model publication/share admission input from prepared capture refs.
- [x] Require sanitized file-write and capture-prep evidence.
- [x] Block unresolved export issues and non-management file refs.
- [x] Block missing approval or unsupported adapter family.

## Acceptance Criteria

- [x] Accepted admission is evidence-based and no-effect.
- [x] Rejected or blocked admission produces controlled reasons.
- [x] Admission does not write files, mutate SCM/forge, import projections, or
  promote tasks.

## Evidence

- `crates/nucleus-server/src/provider_planning_capture_publication_admission.rs`
- `crates/nucleus-server/src/provider_planning_capture_publication_admission/tests.rs`
- `cargo test -p nucleus-server planning_capture_publication`
