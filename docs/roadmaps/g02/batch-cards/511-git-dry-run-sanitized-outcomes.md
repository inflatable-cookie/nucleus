# 511 Git Dry Run Sanitized Outcomes

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../109-git-scm-capture-dry-run-adapter-proof.md`

## Purpose

Record sanitized Git dry-run outcomes without raw diff or command output.

## Scope

- Preserve path counts, summary counts, status labels, and evidence refs.
- Keep raw stdout/stderr/diff out of core records.
- Preserve failed and blocked outcomes.

## Acceptance Criteria

- [x] Outcomes retain refs and counts only.
- [x] Raw output is rejected.
- [x] Failed and blocked outcomes remain visible.
- [x] No commit, push, or forge authority is granted.

## Validation

- `cargo test -p nucleus-server git_dry_run_sanitized_outcomes -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
