# 401 Live Evidence Review Diagnostics

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../087-explicit-live-evidence-review-acceptance.md`

## Purpose

Expose live evidence review decision diagnostics to clients.

## Scope

- Count admitted, blocked, persisted, duplicate, accepted, rejected,
  needs-changes, and abandoned decisions.
- Include sanitized refs and status labels only.
- Keep diagnostics read-only.

## Acceptance Criteria

- [x] Diagnostics summarize review decisions.
- [x] Blockers and duplicate states are visible.
- [x] No raw material appears in DTOs.
- [x] Clients receive no mutation authority.

## Validation

- `cargo test -p nucleus-server live_evidence_review_diagnostics -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
