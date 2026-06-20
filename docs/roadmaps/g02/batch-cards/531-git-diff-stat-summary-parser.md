# 531 Git Diff Stat Summary Parser

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../113-git-read-only-runner-proof.md`

## Purpose

Parse `git diff --stat --no-ext-diff` output into sanitized summary counts.

## Scope

- Count changed files, insertions, and deletions from bounded stat output.
- Preserve failed or unparseable states as repair evidence.
- Do not retain file names or raw diff output.

## Acceptance Criteria

- [x] Parser extracts diff-stat totals.
- [x] Parser handles empty diff output.
- [x] Parser rejects malformed bounded output.
- [x] Parser records no raw file names or diff hunks.

## Validation

- `cargo test -p nucleus-server git_diff_stat_summary_parser -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
