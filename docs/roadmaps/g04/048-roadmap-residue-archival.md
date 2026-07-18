# 048 Roadmap Residue Archival

Status: superseded
Owner: Tom
Updated: 2026-07-18

Superseded 2026-07-18 by operator decision: closed-generation batch cards
stay in place. They are contained in their closed `gNN/` directories,
correctly indexed, and serve as validation evidence per the deferred-lanes
return rules. The audit measured volume, not harm — the cards are inert,
unlike the live-code sprawl the rest of the band fixed. If repo-wide search
noise ever bites, the fix is a search-tool exclude, not a file move. See
`../../logs/2026-07-18-roadmap-archival-superseded.md`.

## Purpose

Archive closed-generation batch-card residue so the docs spine returns to
signal: keep vision, contracts, specs, logs, generation READMEs, and milestone
files; move the per-card ritual out of the main tree.

Audit basis: `../../logs/2026-07-17-codebase-audit-findings.md` (2,019 of
2,140 docs files under roadmaps; g03 batch-cards alone: 601 files).

## Governing Refs

- `../../contracts/001-working-rules.md`
- `../README.md` (docs spine front door)

## Execution Plan

- [ ] Archive `g01`-`g03` `batch-cards/` trees and closed lanes (archive
  branch or `docs/roadmaps/archive/`), preserving deferred-lane evidence refs.
- [ ] Keep per generation: README, milestone files, `long-term-plan.md`,
  `generation-index.md`; update deferred-lanes refs to archived paths.
- [ ] Update Effigy docs QA so link checks pass against the archived layout.

## Goals

- [ ] docs volume drops ~90% with no loss of decisions, contracts, or
  evidence pointers

## Acceptance Criteria

- [ ] `effigy qa:docs` and `qa:northstar` pass after archival
- [ ] deferred-lanes return-refs still resolve
- [ ] active g04 surfaces untouched

## Batch Cards

Planned:

- `batch-cards/218-closed-generation-archival.md`
- `batch-cards/219-docs-qa-and-reference-repair.md`
