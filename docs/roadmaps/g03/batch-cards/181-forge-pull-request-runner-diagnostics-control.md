# 181 Forge Pull Request Runner Diagnostics Control

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../053-forge-pull-request-runner-proof.md`

## Purpose

Expose stopped PR runner state through read-only diagnostics/control DTOs.

## Acceptance Criteria

- [x] Diagnostics summarize PR runner outcomes and repair states.
- [x] Control DTOs expose counts and refs only.
- [x] Clients receive no pull-request creation, forge/provider write,
  callback, recovery, task, or raw-output authority from diagnostics.
- [x] Existing warning-sized request/control files are split if touched.

## Validation

- `cargo test -p nucleus-server forge_pull_request_runner`
- `cargo check -p nucleus-server`
- `effigy doctor`
- `git diff --check`
