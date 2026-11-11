# 008 — Bounded worker checkpoint continuation

Status: implemented
Owner: Nucleus lifecycle maintainers
Created: 2026-09-15
Governing refs: `docs/knowledge/contracts/orchestration.md`,
`docs/knowledge/contracts/durable-telemetry.md`

## Problem

A worker that deliberately stops at a requested bounded checkpoint is currently
indistinguishable from a missing callback or stopped delivery. Nucleus creates a
Coordinator even when the worker, workspace and partial commits are healthy and
the next step is explicit. Seven of eighteen recoveries since local midnight in
the first instrumented cohort had this shape.

## Contract

Add the authenticated worker outcome `progress_checkpoint`. It is not task
completion, semantic blocking, a review revision or an administrative recovery.
It is valid for the task's worker before Nucleus accepts a PR, and for the
task's current revision run on a retained PR (planner ruling, nucleus#974): a
long revision is the same worker continuing the same task, so it reaches the
same bounded stop instead of reporting error for an unfinished turn.

The receipt carries a concise continuation summary and the exact local head.
Nucleus accepts it only when task, run, worker, workspace and branch identities are
current, the worktree is clean, and any head beyond the dispatch base is the
exact pushed queue-branch head. Dirty work, unpublished commits, scope change,
missing identity or uncertain delivery uses normal attention and recovery.

An accepted receipt durably releases the completed turn, increments a task-level
checkpoint ordinal, records the summary and head, and persists the next-turn
intent before asking Paseo to continue the same worker in the same workspace.
Before each delivery or restart retry, Nucleus freshly verifies that the retained
worker's registered workspace still points to the task's worktree and that its
directory exists. A confirmed archive, removal or identity change is recorded
as a checkpoint-continuation preflight failure and sent to normal attention
without sending a message or consuming a delivery attempt. An unavailable
preflight read defers delivery; it does not count as an uncertain send.
Restart reconciliation resumes an available intent once; duplicate callbacks
do not create another turn.

## Budget and authority

A task may accept at most three progress checkpoints. The counter is durable and
survives restart, and it is the task's: revision runs share it rather than
minting an allowance per run (planner ruling, nucleus#974). A fourth checkpoint
enters normal needs-attention handling. The continuation prompt contains only
the authenticated checkpoint summary, original immutable instruction and exact
retained identities. It cannot expand scope, create a nested task, accept
partial delivery or bypass review.

A revision checkpoint is accepted only for the task's current, unreleased
revision run in the retained worker and workspace, and its continuation is
delivered to that run with that run's identity and credential. Blocked, errored
or missing-callback runs remain on their existing paths. A worker cannot use
this outcome for a reviewer, verifier, closeout agent or Coordinator, and the
initial worker cannot use it after a PR is accepted.

## Exhausted-budget errors (project-a #1980, 2026-10-05)

With its budget spent, a long pre-PR worker reported error as a
pseudo-checkpoint ('assessment incomplete; not a provider/external blocker')
and recovery resumed it in an endless chunk loop: a successful resume resets
the coordinator budget, and each new chunk summary changes the recovery
fingerprint, so the same-issue guard never fired.

- The worker prompt states that blocked/error are for concrete observed
  execution failures and external blockers, and that an exhausted budget means
  commit and continue to the PR, never error as another checkpoint. An
  unfinished task, an estimated turn budget or self-assessed context pressure
  alone is not a blocker: keep reading within bounds, commit real progress and
  continue the authorized action. A provider or runtime limit that actually
  prevents progress stays reportable with its observed error, and never with a
  usage snapshot alone. Reporting blocked does not promise a fresh session
  ([orchestration](../contracts/orchestration.md#progress-checkpoints)).
- Recovery classifies a pre-PR blocked/error report after a spent budget that
  self-declares 'incomplete' with no execution failure as a pseudo-checkpoint.
  The first one still resumes; a repeat escalates to the planner instead of
  resuming again, in both the recovery route and the coordinator-result handling.
- Genuine execution failures keep their existing recovery paths; the
  classifier requires both the incomplete signal and the no-failure disclaimer,
  and any explicit execution-failure evidence (failing tests, failed commands,
  errors, timeouts) vetoes the classification even when both signals match.

## Telemetry

Record worker checkpoint receipts and continuation turns separately. Their time
remains worker active time. They do not increment recovery, semantic revision or
operator-administration rates. Historical tasks without the new facts remain
readable and partial only where stage evidence was already partial.

## Acceptance oracle

- A clean pushed partial head receives one retained-worker continuation without
  a Coordinator or new task, agent, workspace or branch.
- Duplicate delivery and restart reconcile one ordinal and one continuation.
- A missing or changed retained worktree is recorded before delivery, consumes
  no continuation attempt and sends no worker message.
- Dirty work, an unpushed head, wrong identity, scope change and uncertain
  provider delivery fail closed through existing recovery.
- Three checkpoints continue; the fourth reaches needs attention.
- Existing blocked, error, ready-for-review and semantic-revision outcomes keep
  their current meaning.
- RPC, callback helper, worker instructions, task detail and telemetry expose the
  new outcome without treating it as completion.

## Exclusions

No nested task graph, automatic scope decomposition, unlimited turns, partial
completion, provider-weight change, Nucleus restart or live-task rewrite belongs
to this work.
