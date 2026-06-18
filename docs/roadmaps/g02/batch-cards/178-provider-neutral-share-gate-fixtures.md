# 178 Provider Neutral Share Gate Fixtures

Status: planned
Owner: Tom
Updated: 2026-06-19
Milestone: `../039-scm-management-capture-and-share-foundation.md`

## Purpose

Prove that capture/share gates do not assume Git-only commits or pushes.

## Scope

- Add fixtures for Git-like and Convergence-like management capture paths.
- Use neutral terms for capture, share, publication readiness, and review
  boundary readiness.
- Keep provider descriptors responsible for Git commit/push and Convergence
  snap/publication mappings.
- Do not execute provider commands.

## Acceptance Criteria

- Core records pass fixtures without requiring `commit`, `push`, `branch`, or
  `pull request` as universal concepts.
- Provider descriptors can still expose Git-specific and Convergence-specific
  labels for UI and adapter mapping.
- Tests fail if core capture/share records regress to Git-only vocabulary.

## Validation

- Targeted Rust tests for neutral capture/share fixtures.
- `rg -n "commit|push|pull request|branch" crates docs/contracts/011-scm-forge-sync-contract.md`
  with intentional matches reviewed.
- `cargo check --workspace`

## Stop Conditions

- Stop if neutral records cannot describe Convergence-like capture/share
  without pretending snaps are commits.
