---
title: Papercuts wave 17 Longhorn sibling layout worker handoff
kind: northstar-handoff
handoff_mode: worker-pr-loop
worker_mode: implementation
dispatch_authority: orchestrator
handoff: single-file-path-only
status: ready-to-launch
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

You are the Nucleus implementation worker. Document that sibling layout
so the next worker can create the link. Do not change the launcher, and
do not retarget the path deps to git pins.

## Why It Matters

A fresh Nucleus worktree cannot `bun install` or run the consumer check
until the symlink exists.

## Current State

- **Repository:** `/Users/tom/Dev/projects/nucleus`
- **Planning branch:** `main`
- **Planning base commit:** `9b3f67c9c7d57700449ef26b5124d1b092093925`
- **Pushed main verification:** local `HEAD` and `origin/main` both resolved
  to that SHA before this handoff was created.
- **Planning checkout:** clean before this handoff file was created.
- **Worker mode:** implementation worker dispatched by the orchestrator.
- **Worker branch:** `worker/papercuts-wave17-longhorn-sibling`
- **Worker worktree:** launcher first. `.agents.local.env` is absent in
  the planning checkout; if the launcher did not supply a clean
  dedicated non-`main` worktree, ask the operator for
  `AGENTS_WORKTREE_CONTAINER_DIR` before creating a fallback. Never use
  `/tmp`.
- **Required sibling worktree links:**
  - `longhorn` from `/Users/tom/Dev/projects/longhorn` as `../longhorn`
  Create when absent; reuse only a symlink that already resolves to that
  source; stop on any other existing path; never overwrite.
- **Ready work items, in order:**
  1. Nucleus worktree missing sibling Longhorn symlink —
     `apps/desktop/package.json` and `apps/desktop/src-tauri/Cargo.toml`
     path-deps are `../../../longhorn/...`, so a worktree at
     `.t3/worktrees/nucleus/<id>` needs `../longhorn` → the primary
     Longhorn checkout (`.t3/worktrees/nucleus/longhorn`). Put a short
     always-loaded note in `AGENTS.md`: create-if-absent,
     reuse-if-already-correct, stop-on-conflict, never overwrite. Do
     not change the path deps to git pins. Do not automate T3.
- **Out of scope:** Poodle-owned relative handoff paths ("Worker
  handoff path not in Nucleus checkout" — that is absolute-path
  dispatch, already encoded in Northstar); editing Longhorn; GitHub
  workflows; release mutations.
- **Canonical refs:** `PAPERCUTS.md`; `AGENTS.md`;
  `apps/desktop/package.json`; `apps/desktop/src-tauri/Cargo.toml`.
- **Required validation:** `AGENTS.md` names the `../longhorn` sibling
  link and the create/reuse/stop/never-overwrite rule. With that
  sibling present, `effigy check:longhorn-consumer` can start (do not
  require it green against unrelated Poodle drift).
- **PR URL:** pending
- **Merge authorisation:** absent; do not merge

## Boundaries

- Document the sibling layout. Do not retarget the path deps. Do not
  merge.

## Important Context

- `docs/handoffs/` did not exist before this file. Keep this as the
  first handoff here. Creating it does **not** close the Poodle
  cross-repo relative-path papercut.
- kimi-shell wave 16 documented the same sibling rule for a shallower
  path; match that create/reuse/stop/never-overwrite language.
- **Report to:** the operator.

## Suggested Next Move

Read this file from the top. Run the worktree-safety preflight. After
the committed `HEAD` handoff checks out, create the Longhorn sibling
link, then write the layout note.

## Completion Protocol

### Before you start

1. Read this handoff path. Its `worker_mode: implementation` and
   `dispatch_authority: orchestrator` metadata activate worker mode. Then
   run `git rev-parse --show-toplevel`, `git branch --show-current`,
   `git status --porcelain`, and `git worktree list --porcelain`.
2. If the current root is a registered worktree, status is empty, and the
   branch is not `main`, accept it. Record the actual path/branch.
3. If the launcher supplied a dirty or `main` worktree, stop and report
   it. `.agents.local.env` was absent; ask before creating a fallback.
   Never use `/tmp`.
4. From the selected worktree, record the repository-relative path
   `docs/handoffs/20260830-173920-papercuts-wave17-longhorn-sibling.md`.
   Confirm `HEAD == origin/main`, ancestor
   `9b3f67c9c7d57700449ef26b5124d1b092093925`, and that relative path in
   `HEAD`. Load
   `git show HEAD:docs/handoffs/20260830-173920-papercuts-wave17-longhorn-sibling.md`.
   If the absolute dispatch file differs, stop. The `HEAD` copy is
   canonical.
5. Then create the sibling links from that tracked list. Canonicalize
   source and destination. Create when absent; reuse only a correct
   symlink; stop on conflict; never overwrite. Do not skip a listed
   catalog member.
6. Read `AGENTS.md` and `PAPERCUTS.md`.

### When the assigned runway is complete

1. Update `PAPERCUTS.md`. Push a PR. Do not merge.

### Review and merge path

Awaiting orchestrator review. Merge is operator-authorised only.

- **Closeout refs:** `PAPERCUTS.md`; this handoff; the PR.

### Handoff closeout

Leave the Poodle-owned relative-handoff-path papercut open.
