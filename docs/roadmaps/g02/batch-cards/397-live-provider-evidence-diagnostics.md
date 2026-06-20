# 397 Live Provider Evidence Diagnostics

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../086-durable-live-evidence-task-work-linkage.md`

## Purpose

Expose live provider evidence task-linkage diagnostics for clients.

## Scope

- Report candidate, observation, review-readiness, and repair-required counts.
- Include task/work/evidence refs and sanitized status labels.
- Exclude raw payloads, raw streams, provider secrets, and unbounded paths.
- Keep diagnostics read-only.

## Acceptance Criteria

- [x] Diagnostics summarize live evidence task linkage.
- [x] Repair-required states are visible.
- [x] No raw material appears in DTOs.
- [x] Clients receive no mutation authority.

## Result

Added read-only live provider evidence diagnostics covering candidates,
observations, review readiness, and repair-required counts.

## Validation

- `cargo test -p nucleus-server live_provider_evidence_diagnostics -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
