# 045 Admission Vocabulary Consolidation

Status: planned
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

- [ ] Introduce shared admission vocabulary in core/orchestration: one
  generic `NoEffects`, `EvidenceRef`, admission-status, and diagnostics
  shape parameterized by domain.
- [ ] Migrate provider gates onto the framework incrementally, deleting the
  per-feature 5-file kits as they convert.
- [ ] Replace the nucleusd `typed_response` modules with one generic
  DTO-to-lines renderer plus a declarative query table; delete the redundant
  `matches!` allowlist in `query.rs`.
- [ ] Delete tautological tests (render-grep files, constant-`false`
  assertions, fixture-constant tests); replace with one property test that no
  renderer emits raw payloads.

## Goals

- [ ] one new provider gate = one file plus data
- [ ] adding a query touches one table, not eight files
- [ ] test count drops with zero behavioral coverage lost

## Acceptance Criteria

- [ ] no per-feature `NoEffects` structs remain in nucleus-server
- [ ] `executed: false` literal count drops by an order of magnitude
- [ ] cold `cargo check` time for nucleus-server measurably improves
- [ ] renderer sanitization guaranteed by one shared test, not 424 greps

## Batch Cards

Planned:

- `batch-cards/208-shared-admission-and-evidence-vocabulary.md`
- `batch-cards/209-provider-gate-framework-migration.md`
- `batch-cards/210-typed-response-collapse-and-test-pruning.md`
