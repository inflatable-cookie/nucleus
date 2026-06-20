# 514 Git Dry Run Command Request Records

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../110-git-dry-run-command-execution-boundary.md`

## Purpose

Define typed Git dry-run command request records backed by the descriptor set
from the adapter proof lane.

## Scope

- Represent requested status and diff-stat probes.
- Link each request to descriptor id, repo id, worktree path ref, and evidence
  root ref.
- Reject unknown descriptors and raw output retention.
- Keep request records data-only.

## Acceptance Criteria

- [x] Request records reference known Git dry-run descriptors.
- [x] Unknown or mutating descriptors are blocked.
- [x] Raw output retention remains blocked.
- [x] Records grant no commit, checkout, branch, push, or forge authority.

## Validation

- `cargo test -p nucleus-server git_dry_run_command_request_records -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
