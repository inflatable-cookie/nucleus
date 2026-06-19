# 191 Forge Share Policy Reset

Status: planned
Owner: Tom
Updated: 2026-06-19
Milestone: `../042-change-request-preparation-boundary.md`

## Purpose

Define share and review-boundary policy before change-request records are
implemented.

## Scope

- Clarify provider-neutral change-request vocabulary.
- Separate local evidence packaging from forge mutation.
- Do not call GitHub or any forge API.

## Acceptance Criteria

- Share/review policy is explicit enough for candidate records.
- Forge-specific terms stay adapter descriptors.

## Validation

- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if provider-neutral candidates require GitHub-only fields.
