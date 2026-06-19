# 184 Git Capture Status And Diff Evidence

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../040-git-management-capture-adapter-proof.md`

## Purpose

Link Git status and diff evidence to neutral management capture plans.

## Scope

- Add evidence refs for status, changed paths, and diff summaries.
- Keep raw command output out of committable projection records.
- Preserve sanitized summaries for review.

## Acceptance Criteria

- Capture plans can reference sanitized Git evidence.
- Missing or unsafe evidence blocks readiness.

## Validation

- Targeted Rust tests for Git evidence linkage.
- `cargo check --workspace`

## Stop Conditions

- Stop if capture readiness can pass without reviewable evidence.

## Result

Git capture plans can now link sanitized status evidence, diff summary refs,
and read-only working-copy inspection state before becoming review-ready.
