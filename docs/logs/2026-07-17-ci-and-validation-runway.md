# CI And Validation Runway

Date: 2026-07-17
Lane: g04 CI and validation runway

## Outcome

- added `.github/workflows/ci.yml`: `cargo check --workspace` +
  `cargo test --workspace` on macos-14 with rust-cache; macOS runner because
  seatbelt sandbox tests fail closed elsewhere and the desktop target is a
  macOS Tauri app
- CI scope limits recorded in the workflow header: effigy docs QA is
  local-only (locally built tool), desktop TS is local-only (poodle
  `file:` dependencies live outside the repo)
- desktop tests now run: `bun run test` script, `desktop:test` Effigy task,
  included in the `qa` suite — previously three test files were orphaned
  from every runner
- new control-layer test covers response parsing states including
  unknown-variant drift; full Rust-to-TS round-trip stays with card 215
- local-store gap tests added: conflict payload contents (expected/actual
  revisions), delete revision expectations, must-exist on missing record

## Evidence

- `bun test`: 14 pass across 4 files, wired through `effigy desktop:test`
- `cargo test -p nucleus-local-store`: 15 pass
- first live CI run pending next push to GitHub

## Next

Push to GitHub to verify the workflow, then seed one failure to prove CI
fails red. Milestone 044 (persistence correctness) is the next lane: it
formalizes the CAS transaction the audit flagged as the top storage risk.
