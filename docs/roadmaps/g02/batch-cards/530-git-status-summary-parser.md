# 530 Git Status Summary Parser

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../113-git-read-only-runner-proof.md`

## Purpose

Parse `git status --porcelain=v1 -z` output into sanitized summary counts.

## Scope

- Count staged, unstaged, untracked, and total changed paths.
- Reject malformed or oversized output.
- Do not retain path names or raw output.

## Acceptance Criteria

- [x] Parser counts porcelain status entries.
- [x] Parser handles empty status output.
- [x] Parser rejects malformed bounded output.
- [x] Parser records no raw path names.

## Validation

- `cargo test -p nucleus-server git_status_summary_parser -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
