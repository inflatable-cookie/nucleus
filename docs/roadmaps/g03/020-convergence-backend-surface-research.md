# 020 Convergence Backend Surface Research

Status: completed
Owner: Tom
Updated: 2026-06-21

## Purpose

Inspect `../convergence` and define the backend boundary needed before a real
Convergence runner can be wired behind the stopped publication adapter.

## Governing Refs

- `docs/roadmaps/g03/019-convergence-stopped-runner-command-adapter.md`
- `docs/architecture/implementation-gap-index.md`
- `docs/contracts/002-harness-adapter-contract.md`

## Goals

- [x] Identify Convergence command, snapshot, publication, and review surfaces.
- [x] Map Convergence terminology without assuming Git commit semantics.
- [x] Define runner boundary gaps before any backend effect is enabled.
- [x] Keep the Nucleus runner stopped-by-default.

## Execution Plan

- [x] Backend surface research batch.
- [x] Runner boundary contract batch.
- [x] Closeout batch.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/073-convergence-backend-surface-research.md`
- `batch-cards/074-convergence-runner-backend-contract.md`
- `batch-cards/075-convergence-backend-research-closeout.md`

## Acceptance Criteria

- [x] `../convergence` evidence is summarized without copying product code.
- [x] The runner boundary distinguishes snapshots, publication, and authority
  promotion from Git commits, pushes, and pull requests.
- [x] Any real backend integration remains blocked behind explicit authority,
  preflight, credential, operator, and recovery gates.
- [x] The next implementation lane is selected from researched evidence, not
  guessed adapter shape.
