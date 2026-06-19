# 052 Health Reset Validation And Next Runtime Lane

Status: planned
Owner: Tom
Updated: 2026-06-19

## Purpose

Validate the health repair runway, update gap indexes, and choose the next
runtime lane.

## Governing Refs

- `docs/architecture/implementation-audit.md`
- `docs/architecture/implementation-gap-index.md`
- `docs/roadmaps/long-term-plan.md`

## Goals

- [ ] Clear current god-file error findings or document any remaining block.
- [ ] Update docs after code splits.
- [ ] Select the next runtime lane.

## Execution Plan

- [ ] Doctor batch: rerun `effigy doctor` and normalize any remaining findings.
- [ ] Gap batch: update implementation audit and gap indexes.
- [ ] Decision batch: select the next runtime lane and prepare the next ready
      card.

## Batch Cards

Ready cards:

- None.

Planned cards:

- `batch-cards/226-doctor-god-file-reset.md`
- `batch-cards/227-gap-index-health-rebaseline.md`
- `batch-cards/228-next-runtime-lane-readiness.md`
- `batch-cards/229-health-runway-closeout.md`

Completed cards:

- None.

## Acceptance Criteria

- [ ] `effigy doctor` no longer reports god-file errors, or the remaining
      blockers are explicit.
- [ ] `cargo check --workspace` passes.
- [ ] Roadmap front doors point at one clear next task.

## Gate

Do not open the next runtime lane until health validation finishes.
