# 210 Typed Response Collapse And Test Pruning

Status: planned
Owner: Codex
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

- [ ] adding a query touches the table plus DTO only
- [ ] silent-fallthrough allowlist gone; drift becomes compile error
- [ ] ~500 tautological tests removed, sanitization guaranteed by property
  test

## Validation

- `cargo test -p nucleusd`

## Stop Conditions

- stop before changing output line formats consumed by Effigy tasks without
  updating them
