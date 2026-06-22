# 179 Forge Pull Request Runner Request Adapter

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../053-forge-pull-request-runner-proof.md`

## Purpose

Build sanitized provider request records from PR runner authority records.

## Acceptance Criteria

- [x] Ready authority records produce provider request records with provider,
  base/head branches, title source, and body source refs.
- [x] Shell passthrough is never used.
- [x] Provider I/O is never performed.
- [x] The adapter does not create a pull request.

## Validation

- `cargo test -p nucleus-server forge_pull_request_runner`
- `cargo check -p nucleus-server`
- `git diff --check`
