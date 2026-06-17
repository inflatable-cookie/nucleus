# 026 SCM Forge Capability Neutralization

Status: completed
Owner: Tom
Updated: 2026-06-17
Milestone: `../008-scm-forge-driver-runway.md`

## Purpose

Update the first SCM/forge capability vocabulary so Git and Convergence can
both be described without forcing one model through the other.

## Scope

- Keep SCM storage/workflow capabilities separate from forge collaboration
  capabilities.
- Rename SCM capabilities that currently assume commits, pushes, review
  branches, or merges as universal operations.
- Preserve Git-specific meaning through provider kind, workflow semantics, and
  provider-specific capability records.
- Add or adjust tests for static Git and Convergence capability profiles.
- Keep the implementation metadata-only. Do not run SCM commands.

## Candidate Direction

Neutral core terms should prefer:

- capture over commit when naming local state recording
- publish/share over push when naming transfer to shared authority
- review boundary over pull request when the forge concept is not known
- integrate over merge when the SCM may use bundles, gates, or publications

Git-specific wording may still appear in Git descriptors, UI labels, and
forge-specific capabilities.

## Acceptance Criteria

- Convergence can be represented without claiming it supports Git commits.
- Git can still expose commit, branch, worktree, push, and pull-request style
  behavior through explicit provider metadata.
- Forge concepts remain separate from SCM storage/capture concepts.
- Tests prove static Git and Convergence profiles resolve distinct workflow
  semantics.

## Validation

- `cargo test -p nucleus-scm-forge`
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if the capability rename ripples into unrelated runtime behavior.
- Stop if neutral terms become too vague to describe Git workflows precisely.

## Outcome

Neutralized `ScmCapability` around capture, sharing, review boundaries,
working-copy sessions, and integration. Added static Git-like and
Convergence-like profile helpers with tests proving they expose different
workflow capabilities.

Aligned native steward capability and approval names with the same
capture/share vocabulary.
