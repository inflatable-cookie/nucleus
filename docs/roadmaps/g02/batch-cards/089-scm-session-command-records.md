# 089 SCM Session Command Records

Status: completed
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

- [x] SCM session commands are provider-neutral.
- [x] Commands can represent unsupported provider capabilities.
- [x] Commands cannot imply commit, push, merge, or publication.

## Outcome

- Added provider-neutral SCM session command records.
- Commands can carry prepare, inspect, integrate, and cleanup intent without
  executing provider mutation.

## Validation

- [x] `cargo test -p nucleus-scm-forge`
- [x] `cargo test -p nucleus-engine scm`
- [x] `cargo check --workspace`
- [x] `effigy qa:docs`
- [x] `effigy qa:northstar`
- [x] `git diff --check`

## Stop Conditions

- Stop if command records require real working-copy mutation.
