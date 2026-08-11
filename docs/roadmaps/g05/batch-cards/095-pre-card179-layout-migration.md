# 095 Pre-Card-179 Layout State Migration

Status: withdrawn
Owner: Tom
Created: 2026-08-11
Milestone: none yet (shell quality / longhorn consumer lane)
Depends on: longhorn card 179 (surfaces absorb containers; merged in
  longhorn main as `dfa72456` + `a4dda1f7` + transform `6ac65fa6`)
Auto-start next card: no

## Objective

The desktop app currently fails to start for any operator with pre-179
layout state:

```
Nucleus layout domain requires recovery: Recovery(RecoveryState {
  kind: InvalidValue,
  path: ".../com.inflatablecookie.nucleus/config/project-layouts.json" })
```

Longhorn's card 179 refactor (a Surface is the layout; containers are gone)
changed the persisted layout document shape. Nucleus consumes longhorn by
path dependency, so the new codec is live, but
`registered_layout_domain`
(`apps/desktop/src-tauri/src/workspace_ui/runtime/project_documents.rs:16-34`)
still wires `NoLayoutMigration` — a stored v1 document (`value.document.containers[]`)
fails validation instead of migrating. Wire the longhorn-shipped transform
so v1 state migrates on load instead of demanding recovery.

## Governing Refs

- `longhorn/crates/longhorn-surfaces-config/src/card179.rs` —
  `merge_pre_card179_state(layout, surfaces, unbound_host)`; nucleus never
  persisted a separate Surface document, so `surfaces` is `None` and
  container ids become Surface ids (identity preserved)
- `longhorn/crates/longhorn-surfaces-config/src/layout_migration.rs` — the
  `LayoutMigration` trait (`validate_raw` + `migrate_one` +
  `LayoutMigrationTarget::encode_current`); "a registry change must also
  bump the domain schema"
- `longhorn/docs/roadmaps/g02/batch-cards/179-surfaces-absorb-containers.md`
  — the refactor card, including the consumer instructions
- `apps/desktop/src-tauri/src/workspace_ui/runtime.rs:38-40` —
  `LAYOUT_DOMAIN_ID`, `LAYOUT_DOMAIN_SCHEMA = 1`
- `apps/desktop/src-tauri/src/workspace_ui/migration.rs` — the older
  legacy-import path; do not break it
- Live evidence: the operator's stored
  `project-layouts.json` is `{"domain":"nucleus.project-layouts",
  "schemaVersion":1,"value":{"document":{"containers":[...]}}}`

## Environment Notes

- The worktree parent (`nucleus-wt/`) symlinks `longhorn` to the live
  sibling checkout; the path dependencies resolve through it. Longhorn main
  already contains card 179.
- Nucleus's swallowtail consumption is pinned by git rev in `Cargo.toml`;
  no swallowtail work is involved in this card.

## Worker Rules

- Execute the card exactly; no planning authority; no sub-agents.
- Do NOT touch roadmap/milestone/card/dispatch status files — deliverables +
  batch log only.
- Longhorn sources are read-only for this card; a gap in the transform or
  the trait is a stop-condition finding with citations.
- Commit on branch `thread/095-pre-card179-layout-migration` and push with
  `git push -u origin thread/095-pre-card179-layout-migration`; no merge.

## Scope

- `apps/desktop/src-tauri/src/workspace_ui/runtime/project_documents.rs`
  (and sibling modules as needed):
  - Bump `LAYOUT_DOMAIN_SCHEMA` to 2 (registry/digest change requires it
    per the trait docs).
  - Implement `LayoutMigration` for a nucleus type replacing
    `NoLayoutMigration`: `migrate_one(from = 1, value, target)` runs
    `merge_pre_card179_state(&layout_value, None, unbound_host)` and
    encodes via `target.encode_current(...)`; `validate_raw` accepts the
    v1 containers shape and rejects anything else at v1.
  - `unbound_host`: the window nucleus actually hosts its workspace in —
    find the real `WindowId` the desktop uses for the primary window
    (`window_host/migration.rs` fixtures suggest `window:primary`; verify
    against production code, not the fixture).
  - Confirm what `StoredLayout` in card179.rs expects (raw `value` vs.
    the `{"document": ...}` wrapper) and hand it the right slice.
- Tests: fixture built from the real pre-179 shape (containers + regions +
  panel instances) asserting: v1 loads and migrates to the current schema;
  container ids survive as Surface ids; panel instance ids and region
  contents survive; revision moves to the higher of the two per the
  transform; garbage at v1 is rejected by `validate_raw`; a current-schema
  document round-trips untouched.
- Batch log `docs/logs/2026-08-11-pre-card179-layout-migration.md`.

Out of scope: longhorn source changes, the panel-presentation domain
(`project-panel-presentations.json` is unaffected — instance ids are
preserved), any UI change, swallowtail.

## Acceptance

- [ ] stored v1 layout documents migrate on load; the app starts without
  the recovery error
- [ ] Surface ids equal the pre-179 container ids; panels and regions
  intact after migration
- [ ] schema bumped to 2; `validate_raw` rejects non-conforming v1 data
- [ ] fixtures + the src-tauri test suite pass; batch log pushed

## Evidence

- Batch log with commands + exit states and fixture names.

## Stop Conditions

- `merge_pre_card179_state` cannot express nucleus's v1 shape (e.g. its
  `StoredLayout` expects a different wrapper) → stop with citations
- The migration needs the panel-presentation domain joined in (the
  transform's contract says layout + surfaces only) → stop and report
- The primary window id is not discoverable from nucleus source → stop and
  ask

## Withdrawal

Withdrawn 2026-08-11 before merge; worker diff discarded uncommitted.

- The operator cleared local state and started fresh rather than migrating;
  the parallel longhorn sweep staged-deleted `card179.rs` and the
  `merge_pre_card179_state` export (transform exists only at longhorn
  `6ac65fa6`), so the wiring target is gone upstream.
- Consequence to remember: nucleus has **no** migration path for pre-179
  layout state. Any install holding a `schemaVersion: 1`
  `project-layouts.json` will hard-fail at startup with
  `Nucleus layout domain requires recovery`; the remedy is archiving or
  deleting that file (panel arrangement is the only casualty).
- Worker evidence worth keeping: after any v1→v2 migration longhorn refuses
  the first mutation with `MigrationBackupRequired { from: 1, to: 2 }` —
  the v1 source is preserved byte-identical until backed up out-of-band
  (`longhorn-config domain_store/mutation/basic.rs`). If migration ever
  returns as a card, the backup step is part of the design, not an
  afterthought.
