# Window Region Panel Simplification

Date: 2026-07-13
Lane: `g04/031-window-region-panel-simplification.md`

## Decision

Remove hosted Surface as workspace identity. Product use showed that the
Surface strip duplicated project switching and panel tabs without a separate
workflow.

Canonical hierarchy:

```text
display -> window -> region -> panel
```

Poodle's visual `Surface` primitive and surface color/radius tokens are not
part of this model and remain unchanged.

## Delivered

- desktop config schema v2: one primary window, direct layout ratios, direct
  regions
- schema-v1 read migration: former active Surface becomes the primary window;
  inactive Surfaces are intentionally dropped
- no product Surface strip or create/rename/close/reorder Surface controls
- unchanged panel tabs, create/recovery menu, focus, close, reorder,
  cross-region move, empty-region reveal, and split persistence
- no `SurfaceId`, Surface records, hosted-Surface lifecycle, or active-Surface
  helpers in `nucleus-workspaces`
- project panel placement and resolution target Window ids and Region ids
- active architecture/contracts promoted; old Surface spec archived

## Evidence

- isolated workspace UI config tests: 4 passed
- `nucleus-workspaces`: 15 passed
- `effigy check:rust`: passed
- `effigy desktop:check`: zero diagnostics
- `effigy desktop:build`: passed
- `effigy qa:docs`: passed
- `cargo fmt --all -- --check`: passed
- `git diff --check`: passed

The normal native desktop test host stalled before filtered tests began, so the
pure `workspace_ui.rs` tests were also run through an isolated Rust test host.
All four passed. Collaborative preview reached the running web page, but
snapshot capture was unavailable. Live desktop inspection remains the operator
checkpoint.

## Limits

- no native secondary-window creation
- no arbitrary split tree or preset manager
- no cross-device layout sync
- no preservation of inactive schema-v1 Surfaces
