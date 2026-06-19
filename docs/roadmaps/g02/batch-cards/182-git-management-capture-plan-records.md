# 182 Git Management Capture Plan Records

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../040-git-management-capture-adapter-proof.md`

## Purpose

Add Git-specific capture plan records derived from neutral management capture
requests.

## Scope

- Add plan records for candidate files, expected status, and adapter mapping.
- Keep plans dry-run and non-mutating.
- Do not commit, stage, push, or mutate refs.

## Acceptance Criteria

- Git capture plans can be represented without provider execution.
- Tests cover accepted and blocked plan cases.

## Validation

- Targeted Rust tests for Git capture plan records.
- `cargo check --workspace`

## Stop Conditions

- Stop if plans cannot stay separate from commit execution.

## Result

Added Git management capture plan records derived from accepted neutral capture
admissions. Plans retain adapter labels but do not stage, commit, push, or
mutate refs.
