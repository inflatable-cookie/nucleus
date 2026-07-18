# 215 Envelope Typegen Or Roundtrip Guard

Status: completed
Owner: Claude
Updated: 2026-07-18
Milestone: `../047-desktop-contract-integrity.md`
Auto-start next card: no

## Objective

Guarantee the TS control envelope union cannot silently drift from the Rust
DTOs.

## Steps

- prefer generation: `ts-rs` or `specta` derive on `Control*Dto`, emit into
  `apps/desktop/src/lib/control/`; else add a round-trip test serializing
  every `ControlResponseBodyDto` variant to JSON and validating against the
  TS types in CI
- align protocol name/version constants from one source
- cover the ~31 Rust variants currently missing from the TS union

## Acceptance

- [ ] a renamed/removed Rust field fails CI
- [ ] TS union covers all Rust body variants
- [ ] protocol constants single-sourced

## Validation

- `effigy qa` (with desktop tests wired from card 204)

## Stop Conditions

- stop before introducing runtime schema validation libraries beyond what
  drift protection needs
