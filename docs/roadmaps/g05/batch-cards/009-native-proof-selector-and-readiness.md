# 009 Native Proof Selector And Readiness

Status: planned
Owner: Tom
Updated: 2026-07-25
Milestone: `../003-swallowtail-application-proof-readiness.md`
Auto-start next card: yes

## Objective

Launch and inspect the isolated native profile through Effigy, then prove the
full readiness lane without credentials or provider calls.

## Governing Refs

- Contracts 008, 010, and 030
- roadmap g05.003
- Swallowtail g02 card 040

## Scope

1. Add an Effigy selector that requires an explicit absolute proof data root.
2. Allow the selector to set the bounded proof deadline.
3. Launch the normal Tauri desktop entry with those values.
4. Add a read-only safe evidence summary over the isolated chat records.
5. Exclude prompts, assistant output, raw provider material, credentials,
   absolute user paths, and raw provider ids.
6. Run focused and normal desktop validation.
7. Record exact source versions and the remaining live authority gate.

## Acceptance

- [ ] the selector cannot silently use normal user state
- [ ] the selector launches the normal desktop product path
- [ ] evidence distinguishes expected and observed terminal classes
- [ ] invalid configuration and redaction fixtures fail before effects
- [ ] existing Agent Chat, task tools, history, and sidebar behavior pass
- [ ] no provider call or workspace write occurs

## Validation

- `effigy desktop:check`
- `effigy desktop:test`
- focused Rust tests
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Evidence

- selector inventory
- isolated path assertions
- safe evidence snapshots
- exact test counts and source commits

## Stop Conditions

- evidence needs raw prompts, output, provider payloads, or credentials
- the selector can fall back to `~/.nucleus`
- native proof requires a permanent proof modal
- live authentication becomes necessary
