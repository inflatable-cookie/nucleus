# 218 Closed Generation Archival

Status: planned
Owner: Codex
Updated: 2026-07-17
Milestone: `../048-roadmap-residue-archival.md`
Auto-start next card: no

## Objective

Archive g01-g03 batch-card trees and closed lanes out of the main docs tree.

## Steps

- operator decision: archive branch vs `docs/roadmaps/archive/`
- move `g01/batch-cards`, `g02/batch-cards`, `g03/batch-cards` and closed
  lane files; keep generation READMEs, milestone files, and indexes
- rewrite deferred-lanes and log references to archived paths

## Acceptance

- [ ] docs file count reduced ~90%
- [ ] deferred-lane return-refs resolve
- [ ] g04 active surfaces untouched

## Validation

- `effigy qa:docs`

## Stop Conditions

- do not delete content; archive only
