# 521 Nucleus Research Crate Front Door

Status: completed
Owner: Tom
Updated: 2026-07-03
Milestone: `../120-deep-research-run-brief-foundation.md`

## Purpose

Add a focused `nucleus-research` crate for research run brief records.

## Work

- [x] Add the crate to the workspace.
- [x] Create a small `lib.rs` module index.
- [x] Add named modules for ids, runs, questions, sources, synthesis, refs,
  and storage shape.
- [x] Keep behavior out of broad server modules.

## Acceptance Criteria

- [x] The crate builds.
- [x] `lib.rs` remains a front door, not a catch-all.
- [x] No crawler, browser automation, source retrieval, provider execution,
  model orchestration, promotion, projection, task creation, or UI behavior is
  added.

## Evidence

- `cargo test -p nucleus-research`
- `cargo check --workspace`
