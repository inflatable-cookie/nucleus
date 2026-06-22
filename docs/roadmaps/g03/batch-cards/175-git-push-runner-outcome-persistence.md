# 175 Git Push Runner Outcome Persistence

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../052-git-push-runner-proof.md`

## Purpose

Persist sanitized push runner outcomes and evidence.

## Acceptance Criteria

- [x] Completed, failed, blocked, duplicate, and repair-required outcomes are
  represented.
- [x] Records retain sanitized ids, statuses, counts, evidence refs, remote
  refs, and policy-approved path refs only.
- [x] Raw stdout/stderr and provider payloads are not persisted.
- [x] Duplicate execution identities are deterministic no-ops or blocked
  evidence, not reruns.

## Validation

- `cargo test -p nucleus-server git_push_runner`
- `cargo check -p nucleus-server`
- `git diff --check`
