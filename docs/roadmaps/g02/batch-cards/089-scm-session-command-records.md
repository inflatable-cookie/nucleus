# 089 SCM Session Command Records

Status: ready
Owner: Tom
Updated: 2026-06-18
Milestone: `../022-scm-working-session-runtime.md`

## Purpose

Represent SCM working-session command requests without executing provider
mutation.

## Scope

- Add prepare, inspect, integrate, and cleanup command request records.
- Keep provider kind and capability explicit.
- Link commands to work sessions, task work items, receipts, and evidence.

## Acceptance Criteria

- SCM session commands are provider-neutral.
- Commands can represent unsupported provider capabilities.
- Commands cannot imply commit, push, merge, or publication.

## Validation

- `cargo test -p nucleus-scm-forge`
- `cargo test -p nucleus-engine scm`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if command records require real working-copy mutation.
