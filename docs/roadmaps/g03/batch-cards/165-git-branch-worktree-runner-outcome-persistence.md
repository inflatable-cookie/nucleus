# 165 Git Branch Worktree Runner Outcome Persistence

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../050-git-branch-worktree-runner-proof.md`

## Purpose

Persist sanitized branch/worktree runner outcomes and evidence.

## Acceptance Criteria

- [x] Completed, failed, blocked, duplicate, and repair-required outcomes are
  represented.
- [x] Records retain sanitized ids, statuses, counts, evidence refs, and
  policy-approved path refs only.
- [x] Raw stdout/stderr and provider payloads are not persisted.
- [x] Duplicate execution identities are deterministic no-ops or blocked
  evidence, not reruns.

## Validation

- `cargo test -p nucleus-server git_branch_worktree`
- `cargo check -p nucleus-server`
- `git diff --check`
