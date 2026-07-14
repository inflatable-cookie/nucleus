# 032 Native Window Geometry Persistence

Status: completed
Owner: Tom
Updated: 2026-07-13

## Purpose

Make the simplified primary window retain size, location, display affinity,
and maximized state across desktop restarts.

## Governing Refs

- `../../specs/009-native-window-geometry-persistence.md`
- `../../contracts/006-workspace-layout-contract.md`
- `../../architecture/product-workflow-ui-architecture.md`

## Boundary

This lane extends the existing local `ui.json` authority and native Tauri host.
It does not add another store, renderer window controls, multiple windows, or a
window-state plugin.

## Execution Plan

- [x] Promote placement, restore, fallback, and ownership rules.
- [x] Add schema-v3 placement DTOs, migration, normalization, and pure fallback
  tests.
- [x] Restore before show and persist coalesced native window events.
- [x] Validate desktop, Rust, docs, formatting, and restart behavior boundary.

## Acceptance Criteria

- schema-v2 config loads and rewrites as schema v3 without losing panels
- normal bounds and maximized state survive restart
- a removed display produces a visible bounded window
- geometry writes cannot revert current panel or split state
- startup shows no default-position flash

## Batch Cards

Completed:

- `batch-cards/166-native-window-placement-contract.md`
- `batch-cards/167-window-placement-schema-and-fallback.md`
- `batch-cards/168-tauri-window-restore-and-capture.md`
- `batch-cards/169-native-window-geometry-validation-closeout.md`

## Outcome

Schema migration, pure fallback, Rust integration, desktop checks, and docs QA
pass. The operator confirmed native size and position restoration after restart.
