# 412 Live Evidence Completion SCM Provider Separation

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../089-live-evidence-completion-projection.md`

## Purpose

Prove task completion projection does not imply SCM, change-request, provider,
callback, interruption, or recovery authority.

## Scope

- Exercise completed, blocked, duplicate, and repair-required projections.
- Keep SCM/share/change-request promotion as a separate future lane.
- Keep provider/callback/recovery/interruption execution authority closed.

## Acceptance Criteria

- [x] Completion projection does not start SCM capture or share.
- [x] Completion projection does not start provider writes.
- [x] Completion projection does not answer callbacks or resume/interruption.
- [x] Future SCM/change-request lane is named but not implemented here.

## Validation

- `cargo test -p nucleus-server live_evidence_completion_authority_separation -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
