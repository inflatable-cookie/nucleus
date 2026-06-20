# 529 Git Read Only Runner Adapter

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../113-git-read-only-runner-proof.md`

## Purpose

Add a constrained read-only Git runner adapter for admitted status and diff-stat
commands.

## Scope

- Accept only admitted runner-boundary records.
- Execute only the known status and diff-stat descriptors.
- Keep execution timeout and working-directory refs explicit.
- Return captured output to parser code without persisting raw output.

## Acceptance Criteria

- [x] Runner rejects non-admitted handoffs.
- [x] Runner rejects mutating Git verbs.
- [x] Runner executes only status and diff-stat descriptors.
- [x] Runner output is not persisted directly.

## Validation

- `cargo test -p nucleus-server git_read_only_runner_adapter -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
