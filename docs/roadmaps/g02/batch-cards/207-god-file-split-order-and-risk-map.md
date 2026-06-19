# 207 God File Split Order And Risk Map

Status: planned
Owner: Tom
Updated: 2026-06-19
Milestone: `../045-god-file-health-gate-rebaseline.md`

## Purpose

Choose the split order for the six current god-file errors.

## Scope

- Order files by dependency risk and ease of validation.
- Name the expected module split target for each file.
- Prepare `208` as the first code card.

## Acceptance Criteria

- Split order is explicit.
- Each target has a narrow validation command.

## Validation

- `effigy qa:docs`
- `git diff --check`

## Stop Conditions

- Stop if any split would require behavior changes.
