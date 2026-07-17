# 210 Typed Response Collapse And Test Pruning

Status: completed
Owner: Claude
Updated: 2026-07-17
Milestone: `../045-admission-vocabulary-consolidation.md`
Auto-start next card: no

## Objective

Replace the 38 nucleusd `typed_response` modules with one generic renderer
and delete the tautological test tier.

## Steps

- generic DTO-to-`key=value`-lines renderer (serde-based or trait + macro)
- declarative table for (CLI name, flags, QueryKind); delete the redundant
  `matches!` allowlist in `apps/nucleusd/src/query.rs` and the hand-synced
  help text drift (consider clap)
- delete render-grep test files, CLI per-domain parse copies (table test
  instead), constant-`false` assertions, fixture-constant tests
- add one property test: no rendered output contains raw payload or
  private-prefixed fields

## Acceptance

- [x] adding a query no longer touches a renderer: one serde-driven
  flattener replaces all 38 typed_response modules; state-record queries
  keep their legacy concise output
- [x] silent-fallthrough allowlist deleted from query.rs — every non-state
  response goes through the typed path, so a new variant renders instead of
  erroring or falling through
- [x] 32 render-grep test files deleted; sanitization guaranteed by a
  flattener-level forbidden-key guard plus one property-style test (raw
  payload / secret / private keys dropped at render time)
- [x] deferred, recorded: clap conversion and CLI parse-test table collapse
  (parse tests are behavioral, cheap, low-risk; revisit with a CLI rework)

## Validation

- `cargo test -p nucleusd`

## Stop Conditions

- stop before changing output line formats consumed by Effigy tasks without
  updating them
