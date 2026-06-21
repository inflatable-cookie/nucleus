# 052 Convergence Publication Command Descriptors

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../013-convergence-publication-command-boundary.md`

## Purpose

Create stopped-by-default command descriptors from ready Convergence-like
publication preflight records.

## Acceptance Criteria

- [x] Ready preflight produces snapshot, publish, and review-publication
  descriptors.
- [x] Blocked preflight records are skipped.
- [x] Descriptors carry provider-stage refs but no executable argv.
- [x] No execution effect is added.

## Validation

- `cargo test -p nucleus-server convergence_publication_command_descriptors -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `git diff --check`
