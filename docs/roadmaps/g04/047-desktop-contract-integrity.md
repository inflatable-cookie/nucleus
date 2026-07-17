# 047 Desktop Contract Integrity

Status: planned
Owner: Tom
Updated: 2026-07-17

## Purpose

Stop silent drift between the Rust control envelope contract and its
hand-maintained TypeScript mirror, restore the webview CSP backstop, and
collapse the copy-pasted per-query control modules.

Audit basis: `../../logs/2026-07-17-codebase-audit-findings.md` (Rust 56 body
variants vs TS ~25, no codegen, no runtime validation; `csp: null`; 11
duplicate `QueryFallback` declarations).

## Governing Refs

- `../../contracts/007-server-boundary-contract.md`
- `../../contracts/019-conversation-timeline-contract.md`

## Execution Plan

- [ ] Generate TS envelope types from the Rust DTOs (ts-rs/specta), or add a
  round-trip test covering every `ControlResponseBodyDto` variant through
  JSON into the TS union.
- [ ] Set a strict CSP in `tauri.conf.json`.
- [ ] Collapse per-query control modules onto one generic
  single-record-response parser and shared query builders.
- [ ] Make blocking sync Tauri commands async + `spawn_blocking`; surface
  startup store errors instead of `.expect()` panics; cache editor file
  discovery instead of full-repo reads per open/save.

## Goals

- [ ] a renamed Rust field breaks a test or codegen, never a panel silently
- [ ] desktop control layer duplication removed

## Acceptance Criteria

- [ ] every Rust response variant is representable and validated on the TS
  side
- [ ] CSP active with all panels functional
- [ ] duplicate `QueryFallback`/switch blocks are gone
- [ ] app startup with a broken store shows an error state, not a panic

## Batch Cards

Planned:

- `batch-cards/215-envelope-typegen-or-roundtrip-guard.md`
- `batch-cards/216-csp-and-startup-resilience.md`
- `batch-cards/217-control-layer-collapse-and-io-hygiene.md`
