---
kind: northstar-handoff
title: "g06.002 — Repair lifecycle currentness"
handoff_mode: worker-pr-loop
worker_mode: implementation
dispatch_authority: orchestrator
status: ready-to-launch
owner: Tom
created: 2026-09-13
updated: 2026-09-13
base_required: pushed-main
queue_dispatch: northstar-queue
queue_approval: "Tom said Continue on 2026-09-13 after Northstar g03.012 completed and authorized the bounded portfolio repair."
queue:
  capability: mechanical
  skipPRReview: false
  notifyOriginOnCloseout: false
---

## What This Thread Was Doing

Northstar g03.012 audited the adopted portfolio for duplicate lifecycle currentness. This repository has exact mechanical findings and needs one repository-local repair lane.

## Why It Matters

Canonical lifecycle JSON and generated projections can disagree with hand-maintained status or frontier prose. That creates a second mechanical authority and keeps agents doing manual closeout bookkeeping.

## Current State

- Canonical task: [`g06.002`](../roadmaps/g06/002-repair-lifecycle-currentness.md).
- Planning base before this handoff: `6fd6ec33fd2582842a6fb062102a75a702623e85`.
- The integration checkout was clean and synchronized before promotion.
- Exact currentness findings:
- `docs/roadmaps/g06/README.md` — `duplicate-status-header` in `g06 Orchestration Proof And Forge Reality`
- Exact terminal-handoff backlinks:
- No terminal-task handoff backlink was found in the bounded inventory.

## Boundaries

Edit documentation and planning surfaces only. Apply the task's exact accepted removals and task-free frontier replacements. Do not edit product code, releases, Queue/Effigy source, unrelated planning, generation disposition, or Paseo threads/workspaces.

## Important Context

Use the currently installed Northstar skill. Re-run the audit before editing. Generated lifecycle blocks and this submitted handoff are hook-owned at closeout. Preserve semantic goals, history, policy, decisions, dependencies, and continuation. A doubtful line stays untouched and is returned to Chatterbox with exact path and lines.

## Suggested Next Move

Start from the audit output and repair one listed finding at a time. For an exact terminal-handoff backlink, repoint the durable evidence to a permanent surface; never delete the handoff manually.

## Completion Protocol

Open one non-draft PR from the Queue workspace. Run `effigy skill run northstar/lifecycle:run -- audit-currentness --repo .`, lifecycle projection verification, repository docs checks, normal QA, and `git diff --check`. Independent review must confirm exact-head scope and zero remaining violations. After merge, let the configured repository hook publish terminal state, refresh generated projections, and consume this submitted handoff. Send no routine progress notification; escalate only semantic ambiguity or a decision-changing blocker.
