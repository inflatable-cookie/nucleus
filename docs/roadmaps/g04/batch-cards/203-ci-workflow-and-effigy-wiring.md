# 203 CI Workflow And Effigy Wiring

Status: in progress
Owner: Claude
Updated: 2026-07-17
Milestone: `../043-ci-and-validation-runway.md`
Auto-start next card: no

## Objective

Add automated CI covering the Rust workspace and docs spine.

## Steps

- add a GitHub Actions workflow: `cargo check --workspace`,
  `cargo test --workspace` on macos-14 (seatbelt sandbox tests and desktop
  target are macOS)
- cache cargo target dir; keep runtime tolerable given nucleus-server
  compile weight
- effigy docs QA and desktop TS stay local-only for now: effigy is a locally
  built tool and desktop deps reference `file:../../../poodle/*` outside the
  repo; both noted in the workflow header

## Acceptance

- [x] workflow authored: push/pull_request triggers, rust-cache, check + test
- [ ] first CI run green on GitHub (needs a push; verify after)
- [ ] one seeded failure verified to fail CI, then reverted

## Validation

- CI run green on main

## Stop Conditions

- stop before adding release/publish automation
