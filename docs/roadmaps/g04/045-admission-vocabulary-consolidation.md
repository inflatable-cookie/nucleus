# 045 Admission Vocabulary Consolidation

Status: completed
Owner: Tom
Updated: 2026-07-17

## Purpose

Collapse the stamped per-feature admission/diagnostics/evidence kits into one
shared framework so a new gate costs one file, not 1-2k duplicated lines, and
delete the tautological test tier that pins the duplication in place.

Audit basis: `../../logs/2026-07-17-codebase-audit-findings.md` (350 stamped provider
modules, 1,538 `executed: false`, ~100 bespoke `NoEffects` structs, 424
render-grep assertions).

## Governing Refs

- `../../contracts/020-runtime-receipt-contract.md`
- `../../contracts/022-engine-orchestration-boundary-contract.md`

## Execution Plan

- [x] Introduce shared admission vocabulary in core: `EvidenceRef`,
  `AdmissionStatus`, effect-state family; migrate domain-crate duplicates
  (`NoEffects`/diagnostics shapes move with the card-209 gate framework).
- [x] Migrate provider gates onto the framework incrementally: shared
  no-effects structs swept (1538 -> 802 stamped literals), `AdmissionGate`
  landed with the live-read reference gate, contract 018 mandates it for
  new gates; existing kits convert when next touched.
- [x] Replace the nucleusd `typed_response` modules with one generic
  DTO-to-lines renderer; delete the redundant `matches!` allowlist in
  `query.rs`.
- [x] Delete tautological tests (32 render-grep files); flattener-level
  forbidden-key guard plus property test replaces 424 grep assertions.

## Goals

- [x] one new provider gate = one trait impl in one file (contract 018 rule)
- [x] adding a query no longer touches renderer modules at all
- [x] test count drops with zero behavioral coverage lost (~470 tautological
  tests removed across the lane; net -6k lines)

## Acceptance Criteria

- [x] standard no-effects blocks consolidated into six shared structs;
  remaining per-feature variants (~800 literals) convert when touched —
  order-of-magnitude drop deferred to opportunistic migration, recorded
- [x] `executed: false` literal count 1538 -> 802
- [x] renderer sanitization guaranteed by one shared guard + test, not 424
  greps
- [x] compile-time improvement not measured rigorously (cold-check timing
  noise); line count -6k in nucleusd, module count -70

## Batch Cards

Planned:

- `batch-cards/208-shared-admission-and-evidence-vocabulary.md`
- `batch-cards/209-provider-gate-framework-migration.md`
- `batch-cards/210-typed-response-collapse-and-test-pruning.md`
