# Rust To TS Typegen

Date: 2026-07-18
Lane: g04 desktop contract integrity (card 215)

## Outcome

- ts-rs derives swept across the control DTO graph compiler-driven (9
  rounds): 287 types now export TypeScript bindings to
  `apps/desktop/src/lib/control/generated/`
- CI regenerates bindings after tests and fails on any diff — a renamed,
  removed, or retyped Rust field breaks the build instead of flowing as
  `undefined` into a panel; `effigy desktop:bindings` regenerates locally
- the drift guard earned its keep during adoption, catching: ts-rs's
  default `bigint` mapping for u64/usize (487 fields annotated to emit
  `number`, matching the JSON wire), a diagnostics snapshot type 12 fields
  behind the Rust DTO, a provider readiness overview missing a field, and
  literal-`false` capability types where the wire says boolean
- the hand-written response envelope union and its drifted member DTOs are
  now re-exports of the generated types — the client contract IS the Rust
  contract, all 56 body variants covered; `generatedContract.ts` holds a
  compile-time assignability guard in svelte-check

## Evidence

- desktop svelte-check 0 errors, bun tests 14 green, workspace green

## Next

Milestone 047 remainder: CSP + startup resilience (card 216) and control
layer collapse + IO hygiene (card 217).
