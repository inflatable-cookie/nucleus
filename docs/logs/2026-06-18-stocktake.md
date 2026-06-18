# 2026-06-18 Stocktake

Status: active
Owner: Tom
Updated: 2026-06-18

## Purpose

Assess the repo after the G02 diagnostics tranche and set the next high-level
implementation runway.

Starting posture: strict-paused.

Reason: G02 has completed a large orchestration, diagnostics, management
projection, SCM, steward, and proof-client run. The repo is coherent enough to
continue, but the next lane must prove one real workflow rather than widen all
subsystems.

## Current Position

G02 has completed:

- orchestration and engine boundary split
- event-store persistence hardening
- task command boundary and task timeline projection
- runtime receipts, checkpoints, and diff records
- management projection file IO and sync records
- SCM/forge capability-neutral vocabulary and session records
- Codex live runtime supervision proof records
- native steward and Effigy record surfaces
- server control queries and response DTOs for diagnostics
- disposable desktop diagnostics proof panels

The project is no longer only a documentation skeleton. It has a Rust workspace
with portable crate boundaries, server control APIs, local SQLite state,
Tauri IPC DTOs, a disposable Svelte/Poodle proof shell, and enough read-only
diagnostics to inspect server state without granting client authority.

## Validation State

Recent validation passed:

- `cargo test -p nucleus-server`
- focused diagnostics, steward, SCM, management projection tests
- `cargo test -p nucleus-scm-forge`
- `cargo check --workspace`
- `effigy desktop:check`
- `effigy desktop:build`
- `effigy qa:docs`
- `effigy qa:northstar`

Known health gap:

- `effigy doctor` fails on `scan.god-files`
- the main high-priority split is
  `crates/nucleus-command-policy/src/storage_codec.rs`
- warning-sized files are also growing in server DTOs, request handling,
  desktop control helpers, and desktop CSS

## Product Workflow Choice

The next proof should be task-backed agent work unit.

Reason:

- it is the clearest product thesis: tasks become executable agent work
- it exercises orchestration, task state, runtime receipts, provider runtime,
  checkpoint/diff, diagnostics, and review boundaries together
- Codex runtime supervision already has the strongest bridged-harness runway
- repo-backed management sync and native steward workflows are important but
  are better as follow-on workflows once task execution has a real loop

First runtime target:

- Codex as the first bridged runtime proof

Reason:

- Codex supervision and event-ingestion records already exist
- it avoids making the first task-backed proof depend on unresolved local model
  or native steward backend strategy
- it still leaves native steward as the next comparison lane for app-owned
  harness behavior

## Next High-Level Plan

1. Repair the red health gate before deeper runtime work.
2. Tighten task-backed agent workflow contracts and acceptance criteria.
3. Move task-agent work-unit records from proof shape toward authoritative
   orchestration source records.
4. Connect task delegation to the Codex runtime admission path without
   unattended execution.
5. Add checkpoint/review records for work-unit completion.
6. Extend diagnostics/read models so the proof UI can show work-unit progress.
7. Keep desktop UI disposable and focused on proof visibility.
8. Close with a validation gate and choose the next workflow: management sync
   or native steward.

## Guardrails

- Do not start broad provider execution before the task-backed work-unit path
  has explicit admission, wait, receipt, checkpoint, and review states.
- Do not add final UI design work.
- Do not make Codex the universal harness abstraction.
- Do not mutate real SCM state in this runway.
- Do not add more large catch-all modules while doctor is red.
- Keep repo-backed management sync and native steward in view, but do not run
  them as parallel implementation lanes.

## Decision

Continue G02.

Do not roll to G03 yet. G02 is still the right generation because the work is
still orchestration and engine-core proof. The next runway should add
milestones 029 onward inside G02.
