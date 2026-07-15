# Project Memory Panel

Date: 2026-07-14
Lane: g04 project Memory panel

## Outcome

- replaced the undefined Context product slot with Memory
- added workspace UI schema v5 migration for existing Context panels
- preserved existing panel identity, region, order, and movement policy
- connected accepted-memory and memory-proposal read models to the desktop
- rendered a compact single-column accepted/proposed inspector
- kept review, apply, extraction, projection, and editing controls absent

## Evidence

- `effigy desktop:check` passes
- `effigy desktop:build` passes
- `effigy qa:docs` passes
- `cargo fmt --all --check` passes
- `git diff --check` passes

Focused Rust migration/query guards pass in an isolated validation target. The
run also found and repaired one older `DesktopState` test fixture that had not
added the Terminal runtime field.

## Next

Memory validation is closed. Keep mutating memory review in a separate future
lane. Continue with the project-resource foundation.
