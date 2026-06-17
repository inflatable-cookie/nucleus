# 025 Convergence Shape And Vocabulary Risk Pass

Status: completed
Owner: Tom
Updated: 2026-06-17
Milestone: `../008-scm-forge-driver-runway.md`

## Purpose

Check Convergence and current Nucleus SCM wording before locking driver
capability names.

Nucleus must not bake in Git commit/branch/pull-request assumptions where an
SCM uses different authority units.

## Scope

- Inspect `../convergence` docs and source for the shape of snaps,
  publications, bundles, gates, scopes, promotions, releases, and server
  authority.
- Add a short architecture or research note capturing the Convergence shape as
  an SCM adapter input.
- Review `docs/contracts/011-scm-forge-sync-contract.md` and
  `crates/nucleus-scm-forge/src/` for Git-heavy vocabulary.
- Classify each risky term as provider-specific, neutral core vocabulary, or
  deferred UI wording.
- Identify the minimum vocabulary needed before capability code changes.

## Acceptance Criteria

- A Convergence shape note exists and is linked from the SCM/forge contract or
  roadmap.
- The note clearly maps local capture, shared authority, review boundaries,
  and release/promotion concepts without treating them as Git commits.
- Git-heavy terms in the current SCM crate are inventoried before renaming.
- No branch, worktree, publish, merge, or forge mutation behavior is
  implemented.

## Validation

- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if Convergence source contradicts the current snap/publication/gate
  assumption.
- Stop if the vocabulary pass reveals that a broader SCM contract rewrite is
  needed before code changes.

## Outcome

Added `docs/research/translation-memos/convergence-scm-shape.md` and linked it
from the SCM/forge contract.

The pass confirmed the current architecture assumption: Convergence separates
local capture (`snap`) from shared authority (`publish` to `scope`/`gate`) and
review/release progression (`bundle`, `promote`, `release`). The next code
batch should neutralize SCM capability names without removing Git-specific
refs.
