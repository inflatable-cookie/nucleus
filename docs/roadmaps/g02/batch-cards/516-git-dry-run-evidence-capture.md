# 516 Git Dry Run Evidence Capture

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../110-git-dry-run-command-execution-boundary.md`

## Purpose

Define sanitized evidence capture records for Git dry-run command outcomes.

## Scope

- Store status labels, changed path counts, diff-stat totals, exit status, and
  evidence refs.
- Preserve failed, timed-out, blocked, and repair-required outcomes.
- Keep raw stdout, stderr, and diff bodies out of core records.

## Acceptance Criteria

- [x] Evidence capture stores bounded summary metadata only.
- [x] Raw Git output is rejected.
- [x] Failed and repair-required outcomes remain inspectable.
- [x] Evidence refs can be used by later review or change-request lanes.

## Validation

- `cargo test -p nucleus-server git_dry_run_evidence_capture -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
