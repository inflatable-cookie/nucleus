# 180 Forge Pull Request Runner Outcome Persistence

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../053-forge-pull-request-runner-proof.md`

## Purpose

Persist sanitized stopped PR runner outcomes and evidence.

## Acceptance Criteria

- [x] Completed, failed, blocked, duplicate, and repair-required outcomes are
  represented.
- [x] Records retain sanitized ids, statuses, counts, evidence refs, forge
  refs, branch refs, and text-source refs only.
- [x] Raw stdout/stderr, raw provider payloads, and raw PR title/body text are
  not persisted.
- [x] Duplicate request identities are deterministic no-ops or blocked
  evidence, not reruns.

## Validation

- `cargo test -p nucleus-server forge_pull_request_runner`
- `cargo check -p nucleus-server`
- `git diff --check`
