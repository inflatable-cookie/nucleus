# 009 Native Proof Selector And Readiness

Status: completed
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

1. Add an Effigy selector that requires an explicit absolute proof data root
   and disposable Git fixture.
2. Bind the fresh bootstrap project to that fixture instead of the Nucleus
   source tree.
3. Allow the selector to set the bounded proof deadline.
4. Launch the normal Tauri desktop entry with those values.
5. Add a read-only safe evidence summary over the isolated chat records.
6. Exclude prompts, assistant output, raw provider material, credentials,
   absolute user paths, and raw provider ids.
7. Run focused and normal desktop validation.
8. Record exact source versions and the remaining live authority gate.

## Acceptance

- [x] the selector cannot silently use normal user state
- [x] the seeded working resource cannot silently use the Nucleus source tree
- [x] the selector launches the normal desktop product path
- [x] evidence distinguishes expected and observed terminal classes
- [x] invalid configuration and redaction fixtures fail before effects
- [x] existing Agent Chat, task tools, history, and sidebar behavior pass
- [x] no provider call or workspace write occurs

## Validation

- `effigy desktop:check`
- `effigy desktop:test`
- focused Rust tests
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Evidence

- `desktop:proof` and `desktop:proof:evidence` require explicit absolute
  `NUCLEUS_DESKTOP_DATA_ROOT` and `NUCLEUS_DESKTOP_PROOF_FIXTURE_ROOT`
  values. The fixture must be an existing Git repository.
- Fresh proof state binds the seeded project and task fixtures to that
  repository. Normal desktop startup retains inferred local-project behavior.
- Evidence reads the existing proof database through a query-only SQLite
  backend and returns terminal counts only.
- Redaction fixtures exclude prompts, output, errors, provider ids, project
  ids, credentials, and paths.
- Nucleus base source:
  `7502b761e0a31fb8c3833d2777b068f3f8f998a9`; Swallowtail source:
  `2959810f2da3cc64b28cf979094e0166a34c3ff8`.
- `desktop:check` passes with zero errors; 20 client tests and the focused Rust
  readiness tests pass, including explicit fixture binding. No provider call
  occurred.

## Stop Conditions

- evidence needs raw prompts, output, provider payloads, or credentials
- the selector can fall back to `~/.nucleus`
- native proof requires a permanent proof modal
- live authentication becomes necessary
