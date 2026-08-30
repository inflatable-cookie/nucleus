---
title: Papercuts wave 18 cross-repo handoff path closeout worker handoff
kind: northstar-handoff
handoff_mode: worker-pr-loop
worker_mode: implementation
dispatch_authority: orchestrator
handoff: single-file-path-only
status: ready-to-launch
owner: Tom / papercuts orchestrator
created: 2026-08-30
updated: 2026-08-30
handoff_path: /Users/tom/Dev/projects/nucleus/docs/handoffs/20260830-185610-papercuts-wave18-handoff-path.md
base_required: pushed-main
tags: [coordination, handoff, worker, pr, papercuts]
---

## What This Thread Was Doing

A Poodle-owned adoption handoff was cited as a Nucleus-relative path.
The file lived only under Poodle. Nucleus now has `docs/handoffs/` for
Nucleus-owned lanes. Northstar PR 8 already binds operator-facing
dispatch to the owning repo's **absolute** path.

You are the Nucleus implementation worker. Prove that protocol and close
the copy. Do not copy Poodle handoffs into this repo.

## Why It Matters

The next cross-repo lane still looks like a missing Nucleus file.

## Current State

- **Repository:** `/Users/tom/Dev/projects/nucleus`
- **Planning branch:** `main`
- **Planning base commit:** `b08fb1b6410e1fbef159089992abd58c027298f8`
- **Pushed main verification:** local `HEAD` and `origin/main` both resolved
  to that SHA before this handoff was created.
- **Planning checkout:** clean before this handoff file was created.
- **Worker mode:** implementation worker dispatched by the orchestrator.
- **Worker branch:** `worker/papercuts-wave18-handoff-path`
- **Worker worktree:** launcher first. `.agents.local.env` is absent in
  the planning checkout; if the launcher did not supply a clean
  dedicated non-`main` worktree, ask the operator for
  `AGENTS_WORKTREE_CONTAINER_DIR` before creating a fallback. Never use
  `/tmp`.
- **Required sibling worktree links:** `none`
- **Ready work items, in order:**
  1. Worker handoff path not in Nucleus checkout — close if Northstar
     `1840c9f6d4f7127240622a09e462b06adc094971` (PR 8) requires the
     owning repo's absolute handoff path. Cite that SHA. `AGENTS.md`
     already says worker mode reads a dispatched handoff under
     `docs/handoffs/`; add that the operator-facing path is absolute
     and names the owning repo (Poodle for Poodle-planned adoption
     lanes; Nucleus for Nucleus-owned lanes). Do not copy
     `poodle/docs/handoffs/20260824-231356-g16-011-nucleus-v022-adoption.md`
     into this repo.
- **Out of scope:** editing Poodle or Northstar; T3 launcher; Longhorn
  sibling (closed in wave 17).
- **Canonical refs:** `PAPERCUTS.md`; `AGENTS.md`; Northstar PR 8
  (`1840c9f6d4f7127240622a09e462b06adc094971`).
- **Required validation:** `AGENTS.md` names absolute owning-repo
  dispatch. The Poodle adoption handoff is not duplicated here.
- **PR URL:** pending
- **Merge authorisation:** absent; do not merge

## Boundaries

- Close the copy. Do not import Poodle handoffs. Do not merge.

## Important Context

- Wave 17 added this directory for Nucleus-owned handoffs. That does
  not make Poodle planning files Nucleus files.
- **Report to:** the operator.

## Suggested Next Move

Read this file from the top. Run the worktree-safety preflight. After
the committed `HEAD` handoff checks out, skip sibling links (`none`),
then close the copy.

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
   `docs/handoffs/20260830-185610-papercuts-wave18-handoff-path.md`.
   Confirm `HEAD == origin/main`, ancestor
   `b08fb1b6410e1fbef159089992abd58c027298f8`, and that relative path in
   `HEAD`. Load
   `git show HEAD:docs/handoffs/20260830-185610-papercuts-wave18-handoff-path.md`.
   If the absolute dispatch file differs, stop. The `HEAD` copy is
   canonical.
5. Required sibling list is `none`. Skip link setup.
6. Read `AGENTS.md` and `PAPERCUTS.md`.

### When the assigned runway is complete

1. Update `PAPERCUTS.md`. Push a PR. Do not merge.

### Review and merge path

Awaiting orchestrator review. Merge is operator-authorised only.

- **Closeout refs:** `PAPERCUTS.md`; this handoff; the PR.

### Handoff closeout

If Northstar PR 8 is not the governing rule on the installed skill,
keep the copy open with the SHA you actually read.
