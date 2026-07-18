# 047 Desktop Contract Integrity

Status: completed
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

- [x] Generate TS envelope types from the Rust DTOs: ts-rs across 287
  types, CI diff check, generated union adopted as the client contract.
- [x] Set a strict CSP in `tauri.conf.json`.
- [x] Collapse per-query control modules onto one generic
  single-record-response parser (shared query-builder consolidation left
  to organic refactors; the parser was the drift surface).
- [x] Make blocking sync Tauri commands async + `spawn_blocking`; surface
  startup store errors instead of `.expect()` panics; cache editor file
  discovery and bound the text probe.

## Goals

- [x] a renamed Rust field breaks CI codegen and svelte-check, never a
  panel silently
- [x] desktop control layer duplication removed

## Acceptance Criteria

- [x] every Rust response variant is covered: the generated union is the
  client contract (287 types, CI diff check)
- [x] CSP active; panel walk-through pending operator's next live launch
  (recorded on card 216)
- [x] duplicate `QueryFallback`/switch blocks are gone
- [x] app startup with a broken store shows an error banner, not a panic

## Batch Cards

Planned:

- `batch-cards/215-envelope-typegen-or-roundtrip-guard.md`
- `batch-cards/216-csp-and-startup-resilience.md`
- `batch-cards/217-control-layer-collapse-and-io-hygiene.md`
