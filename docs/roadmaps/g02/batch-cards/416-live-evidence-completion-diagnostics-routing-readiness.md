# 416 Live Evidence Completion Diagnostics Routing Readiness

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../090-live-evidence-completion-control-read-model.md`

## Purpose

Prepare diagnostics routing for live evidence completion projection state.

## Scope

- Name a read-only diagnostics domain for completion projections.
- Map read-model state to routing-ready diagnostics records.
- Keep request handling out of this card unless the boundary already fits.

## Acceptance Criteria

- [x] Diagnostics domain is explicit.
- [x] Routing readiness record maps read-model state.
- [x] Unsupported or missing state is represented as repair/deferred.
- [x] Routing grants no mutation authority.

## Validation

- `cargo test -p nucleus-server live_evidence_completion_diagnostics_routing -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
