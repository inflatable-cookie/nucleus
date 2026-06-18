# 175 SCM Management Capture Policy Reset

Status: ready
Owner: Tom
Updated: 2026-06-19
Milestone: `../039-scm-management-capture-and-share-foundation.md`

## Purpose

Promote the next lane policy before implementation starts.

## Scope

- Clarify provider-neutral capture/share authority in the SCM contract if
  current wording is not precise enough.
- Keep `capture` distinct from Git commit, Convergence publication, push,
  publish, promote, merge, and review-request operations.
- Update architecture and roadmap guardrails if they still imply Git-only
  workflow terms.
- Do not add SCM mutation or provider execution.

## Acceptance Criteria

- Canonical docs define capture/share preparation as a neutral pre-provider
  boundary.
- Git-specific and Convergence-specific mappings remain adapter descriptors,
  not core terminology.
- The next implementation card can add records without reopening policy.

## Validation

- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if the contract cannot define capture/share without choosing a
  provider-specific authority model.
