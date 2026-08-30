---
title: Papercuts wave 17 Longhorn sibling layout worker handoff
kind: northstar-handoff
handoff_mode: worker-pr-loop
worker_mode: implementation
dispatch_authority: orchestrator
handoff: single-file-path-only
status: awaiting-review
owner: Tom / papercuts orchestrator
created: 2026-08-30
updated: 2026-08-30
handoff_path: /Users/tom/Dev/projects/nucleus/docs/handoffs/20260830-173920-papercuts-wave17-longhorn-sibling.md
base_required: pushed-main
tags: [coordination, handoff, worker, pr, papercuts]
---

## What This Thread Was Doing

Launcher worktrees under `.t3/worktrees/nucleus/<id>` have no
`../longhorn` symlink. `apps/desktop` `file:../../../longhorn/...`
deps and `check:longhorn-consumer` then fail until someone makes
`.t3/worktrees/nucleus/longhorn` by hand.

Documented that sibling layout so the next worker can create the link.
Did not change the launcher, and did not retarget the path deps to git
pins.

## Why It Matters

A fresh Nucleus worktree cannot `bun install` or run the consumer check
until the symlink exists.

## Current State

- **Repository:** `/Users/tom/Dev/projects/nucleus`
- **Planning branch:** `main`
- **Planning base commit:** `9b3f67c9c7d57700449ef26b5124d1b092093925`
- **Worker branch:** `t3code/papercuts-wave17-longhorn-sibling`
- **Worker worktree:** `/Users/tom/.t3/worktrees/nucleus/t3code-59913e99`
  (launcher supplied clean non-`main` worktree; accepted)
- **Sibling link:** reused existing
  `.t3/worktrees/nucleus/longhorn` → `/Users/tom/Dev/projects/longhorn`
  (correct symlink; no overwrite)
- **Done:**
  1. `AGENTS.md` always-loaded boundaries name `../longhorn` → the
     primary Longhorn checkout (typically
     `.t3/worktrees/nucleus/longhorn`), that `apps/desktop` path deps
     resolve through `../../../longhorn/...`, and
     create-if-absent / reuse-if-correct / stop-on-conflict /
     never-overwrite. Path deps stay; no git pin; no T3 automation.
  2. Closed the matching papercut in `PAPERCUTS.md` and moved it under
     `## Closed`. Left the Poodle relative-handoff-path papercut open.
- **Out of scope left open:** Poodle-owned relative handoff paths;
  editing Longhorn; GitHub workflows; release mutations; T3 launcher
  changes.
- **Validation evidence:**
  - Sibling resolves to `/Users/tom/Dev/projects/longhorn`.
  - `effigy check:longhorn-consumer` green in the worker worktree.
  - Reviewer at `ce86b0f66cf2c09eb914e290e2b75eb7fb8187fe`:
    `git diff --check`, `effigy qa:docs`, `effigy qa:northstar`,
    `effigy check:longhorn-consumer`.
- **PR URL:** https://github.com/inflatable-cookie/nucleus/pull/2
- **Merge authorisation:** absent; do not merge

## Boundaries

- Document the sibling layout. Do not retarget the path deps. Do not
  merge.

## Important Context

- `docs/handoffs/` did not exist before this file. Keep this as the
  first handoff here. Creating it does **not** close the Poodle
  cross-repo relative-path papercut.
- kimi-shell wave 16 documented the same sibling rule for a shallower
  path; matched that create/reuse/stop/never-overwrite language.
- **Report to:** the operator.

## Suggested Next Move

Orchestrator review of
https://github.com/inflatable-cookie/nucleus/pull/2. Do not relaunch
implementation or recreate the sibling link; evidence and PR URL are
already recorded above. Merge only with operator authorisation.

## Completion Protocol

### Review and merge path

Awaiting orchestrator review. Merge is operator-authorised only.

- **Closeout refs:** `PAPERCUTS.md`; this handoff; the PR.

### Handoff closeout

Leave the Poodle-owned relative-handoff-path papercut open.
