# 032 Forge Pull-Request Descriptor Records

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../007-forge-pull-request-descriptor-dry-run.md`

## Purpose

Define forge pull-request descriptor records from ready push preflight records.

## Scope

- Preserve push preflight refs.
- Preserve upstream commit, branch/worktree, and dry-run identity.
- Require explicit forge provider, base branch, head branch, title source, and
  body source.
- Keep pull-request, forge, provider, callback, interruption, recovery, task
  mutation, and raw-output effects false.

## Acceptance Criteria

- [x] Descriptor records reference push preflight ids.
- [x] Forge provider, base branch, head branch, title source, and body source
  are explicit.
- [x] Non-ready push preflight records are blocked.
- [x] No pull-request or forge effect is executed.

## Validation

- [x] `cargo test -p nucleus-server forge_pull_request_descriptor_records -- --nocapture`
- [x] `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- [x] `git diff --check`
