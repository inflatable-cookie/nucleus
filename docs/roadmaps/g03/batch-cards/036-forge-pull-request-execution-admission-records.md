# 036 Forge Pull-Request Execution Admission Records

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../008-forge-pull-request-execution-admission.md`

## Purpose

Define pull-request execution admission records from reviewable PR dry-run
evidence.

## Scope

- Preserve PR dry-run evidence refs.
- Preserve upstream descriptor, push, commit, branch/worktree, and dry-run
  identity.
- Require explicit operator approval.
- Keep pull-request, forge, provider, callback, interruption, recovery, task
  mutation, and raw-output effects false.

## Acceptance Criteria

- [x] Admission records reference PR dry-run evidence ids.
- [x] Operator approval is explicit.
- [x] Non-reviewable PR evidence is blocked.
- [x] No pull-request or forge effect is executed.

## Validation

- [x] `cargo test -p nucleus-server forge_pull_request_execution_admission -- --nocapture`
- [x] `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- [x] `git diff --check`
