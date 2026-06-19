# 181 Git Capture Descriptor Policy

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../040-git-management-capture-adapter-proof.md`

## Purpose

Define Git management capture as an adapter mapping from neutral capture
records.

## Scope

- Clarify which Git terms are adapter-specific labels.
- Keep neutral capture records free of universal commit/push assumptions.
- Do not execute Git commands.

## Acceptance Criteria

- Git capture descriptor policy is explicit.
- Core records remain provider-neutral.

## Validation

- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if policy requires Git vocabulary in core capture records.

## Result

`docs/contracts/011-scm-forge-sync-contract.md` now defines Git management
capture as an adapter mapping from neutral capture records. Git commit, status,
diff, branch, and push labels stay adapter-specific.
