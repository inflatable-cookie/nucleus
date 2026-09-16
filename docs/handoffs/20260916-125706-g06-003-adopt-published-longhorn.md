---
kind: northstar-handoff
title: "g06.003 — Adopt published Longhorn 0.1.0"
handoff_mode: worker-pr-loop
worker_mode: implementation
dispatch_authority: orchestrator
handoff: single-file-path-only
status: ready-to-launch
owner: Tom
created: 2026-09-16
updated: 2026-09-16
base_required: pushed-main
queue_dispatch: northstar-queue
queue_approval: "Operator direction in the Longhorn thread on 2026-09-16: manage the consumer repoint onto published Longhorn 0.1.0 across the consumer repositories, writing a roadmap task and dispatching a worker per project."
roadmap: docs/roadmaps/g06/003-adopt-published-longhorn-0-1-0.md
tags: [coordination, handoff, worker, pr, longhorn-adoption]
---

## What This Thread Was Doing

Longhorn published `0.1.0` — three TypeScript packages on npm and tag
`v0.1.0` — and this repository still pins Longhorn by an unpublished shape.
This lane moves it onto the published release.

## Why It Matters

The dependency this repository builds against should be the one it claims:
registry versions for the TypeScript packages, and tag `v0.1.0` for the Rust
crates, not a sibling checkout that only exists on a developer machine.

## Current State

- **Done:** the release is published; this task and handoff are committed.
- **Still open:** every dependency edit listed in the canonical task.
- **Active spec lane:** none.
- **Current task:** `docs/roadmaps/g06/003-adopt-published-longhorn-0-1-0.md` (`g06.003`).
- **Canonical refs:** Longhorn contract 012; Longhorn `g02.014`.
- **Remaining continuation envelope:** none — this handoff covers the lane.
- **Lane budget / pause signal:** normal; stop on the task's stop conditions.
- **Required sibling worktree links:** none.
- **Key files:**
  - `apps/desktop/package.json`
  - `apps/desktop/src-tauri/Cargo.toml`

## Boundaries

- **In scope:** the task's Work steps — dependency identity and this
  repository's own checks.
- **Out of scope:** product behaviour, other repositories, and any Poodle
  migration beyond the pin bump the adapter's peer requires.
- **Repo constraints:** follow this repository's `AGENTS.md` and run its own
  Effigy checks.

## Important Context

The exact specifier map is in the canonical task. Longhorn's Rust crates set
`publish = false` and are taken by git tag, not crates.io.

### UI Design Brief

Not applicable.

## Suggested Next Move

Read the canonical task, apply its Work steps, then run this repository's
checks.

## Completion Protocol

Work on the queue-owned branch, not `main`. Apply the task's Work steps, run
`effigy qa`, open a PR from the queue-owned branch, and report
`ready_for_review` through the Queue callback helper in your environment. Fix
review findings on the same branch. Stop and report if an API this repository
uses is absent from published `0.1.0`; do not reintroduce a path dependency.
