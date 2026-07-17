# 204 Desktop Test Wiring And Store Coverage

Status: completed
Owner: Claude
Updated: 2026-07-17
Milestone: `../043-ci-and-validation-runway.md`
Auto-start next card: no

## Objective

Run the existing desktop TS tests everywhere, and add first direct tests for
`nucleus-local-store`.

## Steps

- add `test` script to `apps/desktop` running `bun test`; include in Effigy
  `qa` suite and CI
- add direct `nucleus-local-store` tests: revision expectation matrix
  (exact / must-exist / none), conflict paths, delete semantics, schema
  init idempotency
- add envelope-parsing tests in the desktop control layer against fixture
  JSON captured from Rust DTOs

## Acceptance

- [x] `effigy qa` fails if a desktop TS test fails (`desktop:test` task in
  the qa suite; `bun run test` script added)
- [x] local-store revision and conflict behavior covered directly (conflict
  payload contents, delete expectations, must-exist on missing; reopen and
  expectation tests already existed)
- [x] control response parsing tested for record/empty/unsupported/error and
  unknown-variant drift states; full Rust-to-TS round-trip deferred to card
  215

## Validation

- `effigy qa`
- `cargo test -p nucleus-local-store`

## Stop Conditions

- stop before component/UI test infrastructure; helpers and parsing only
