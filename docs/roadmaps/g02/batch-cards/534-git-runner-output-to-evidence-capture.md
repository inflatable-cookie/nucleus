# 534 Git Runner Output To Evidence Capture

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../114-git-read-only-runner-evidence-composition.md`

## Purpose

Map transient read-only Git runner output to sanitized evidence capture records.

## Scope

- Use status parser output for porcelain status commands.
- Use diff-stat parser output for diff-stat commands.
- Emit capture records with counts and evidence refs only.
- Reject failed, blocked, or malformed runner outputs as repair evidence.

## Acceptance Criteria

- [x] Status runner output maps to sanitized capture counts.
- [x] Diff-stat runner output maps to sanitized capture counts.
- [x] Raw output is not retained in capture records.
- [x] Malformed outputs become repair-required evidence.

## Validation

- `cargo test -p nucleus-server git_runner_output_to_evidence_capture -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
