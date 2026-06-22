# 178 Forge Pull Request Runner Authority Records

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../053-forge-pull-request-runner-proof.md`

## Purpose

Add explicit stopped PR runner authority records from existing PR execution
preflight records.

## Acceptance Criteria

- [x] Ready preflight records can become PR-request authority records only with
  explicit operator PR intent.
- [x] Forge provider, base branch, head branch, title source, and body source
  refs are required.
- [x] Pull-request creation, forge/provider writes, callbacks, interruption,
  recovery, task mutation, and raw-output authority remain blocked.
- [x] Non-ready preflights and missing request refs are repair/blocked records,
  not provider-write permission.

## Validation

- `cargo test -p nucleus-server forge_pull_request_runner`
- `cargo check -p nucleus-server`
- `git diff --check`
