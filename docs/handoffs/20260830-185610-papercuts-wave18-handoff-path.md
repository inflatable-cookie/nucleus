---
title: Papercuts wave 18 cross-repo handoff path closeout worker handoff
kind: northstar-handoff
handoff_mode: worker-pr-loop
worker_mode: implementation
dispatch_authority: orchestrator
handoff: single-file-path-only
status: awaiting-review
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

Proved that protocol and closed the copy. Did not copy Poodle handoffs
into this repo.

## Why It Matters

The next cross-repo lane still looked like a missing Nucleus file.

## Current State

- **Repository:** `/Users/tom/Dev/projects/nucleus`
- **Planning branch:** `main`
- **Planning base commit:** `b08fb1b6410e1fbef159089992abd58c027298f8`
- **Worker branch:** `t3code/papercuts-wave18-handoff`
- **Worker worktree:** `/Users/tom/.t3/worktrees/nucleus/t3code-05bbff99`
  (launcher supplied clean non-`main` worktree; accepted)
- **Required sibling worktree links:** `none`
- **Done:**
  1. Cited Northstar `1840c9f6d4f7127240622a09e462b06adc094971` (PR 8);
     installed skill carries the same absolute owning-repo dispatch rule.
  2. `AGENTS.md` and `034-agent-instruction-surface-contract.md` state
     that the operator-facing path is absolute and names the owning repo
     (Poodle for Poodle-planned adoption lanes; Nucleus for Nucleus-owned
     lanes). Do not treat a sibling repo's handoff as a relative file
     under this checkout.
  3. Closed the matching papercut in `PAPERCUTS.md` and moved it under
     `## Closed`. Did not copy
     `poodle/docs/handoffs/20260824-231356-g16-011-nucleus-v022-adoption.md`.
- **Out of scope left open:** editing Poodle or Northstar; T3 launcher;
  Longhorn sibling (closed in wave 17).
- **Validation evidence:**
  - `AGENTS.md` names absolute owning-repo dispatch.
  - Poodle adoption handoff absent under Nucleus `docs/handoffs/`.
  - Reviewer at `4009e9970a4c13eeb5422fa4d7cbdc9368a6cea1`:
    `git diff --check`, `effigy qa:docs`, `effigy qa:northstar`,
    installed Northstar `check:agent-instructions` (advisory-only).
- **PR URL:** https://github.com/inflatable-cookie/nucleus/pull/3
- **Merge authorisation:** absent; do not merge

## Boundaries

- Close the copy. Do not import Poodle handoffs. Do not merge.

## Important Context

- Wave 17 added this directory for Nucleus-owned handoffs. That does
  not make Poodle planning files Nucleus files.
- **Report to:** the operator.

## Suggested Next Move

Orchestrator review of
https://github.com/inflatable-cookie/nucleus/pull/3. Do not relaunch
implementation or copy Poodle handoffs; evidence and PR URL are already
recorded above. Merge only with operator authorisation.

## Completion Protocol

### Review and merge path

Awaiting orchestrator review. Merge is operator-authorised only.

- **Closeout refs:** `PAPERCUTS.md`; this handoff; the PR.

### Handoff closeout

Northstar PR 8 (`1840c9f6d4f7127240622a09e462b06adc094971`) is the
governing rule on the installed skill; papercut closed.
