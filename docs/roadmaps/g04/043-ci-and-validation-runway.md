# 043 CI And Validation Runway

Status: active
Owner: Tom
Updated: 2026-07-17

## Purpose

Move validation from manual effigy runs pasted into cards to automated CI, and
make the existing desktop tests actually run.

Audit basis: `../../logs/2026-07-17-codebase-audit-findings.md` (no CI;
desktop `bun:test` files wired to nothing).

## Governing Refs

- `../../contracts/001-working-rules.md`
- `../../contracts/016-effigy-project-integration-contract.md`

## Execution Plan

- [x] Add a CI workflow running `cargo check --workspace` and
  `cargo test --workspace` (macos-14; effigy docs QA and desktop TS stay
  local-only until effigy is distributable and poodle file-deps are
  vendored).
- [x] Wire desktop tests: `bun test` task in `apps/desktop`, included in the
  Effigy `qa` suite.
- [x] Add direct test coverage gaps for `nucleus-local-store` (conflict
  payloads, delete expectations, must-exist on missing record).

## Goals

- [ ] every push validates Rust, desktop, and docs spine automatically
- [ ] no test file in the repo is orphaned from every runner

## Acceptance Criteria

- [ ] CI passes on main and fails on a seeded regression (verify after next
  push to GitHub)
- [x] `effigy qa` runs Rust + desktop TS + docs checks
- [x] `nucleus-local-store` has direct tests for revision expectation and
  conflict paths

## Batch Cards

Planned:

- `batch-cards/203-ci-workflow-and-effigy-wiring.md`
- `batch-cards/204-desktop-test-wiring-and-store-coverage.md`
