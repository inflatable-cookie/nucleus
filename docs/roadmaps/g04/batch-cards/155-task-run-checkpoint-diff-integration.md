# 155 Task Run Checkpoint Diff Integration

Status: completed
Owner: Codex
Updated: 2026-07-10
Milestone: `../029-task-attributed-diff-review.md`
Auto-start next card: yes

## Objective

Wrap every write-capable local task execution in accepted baseline and target
source checkpoints and persist the resulting task-owned diff summary.

## Outcome

- Desktop Agent Chat now owns a host-configured snapshot store under local
  Nucleus state, outside the project and `ServerStateService`.
- Every scheduled write-capable task captures and persists a baseline
  checkpoint plus work-item linkage before the runner can start.
- Completed provider turns capture a target, persist exact typed changed-file
  metadata and a diff summary, then link both checkpoints and the diff before
  awaiting review.
- Baseline refusal prevents provider start. Target/diff failure becomes
  recovery required and stops the serial Goal without fabricating review
  readiness.
- Task completion, review acceptance, Goal achievement, and SCM mutation remain
  false throughout this flow.

## Governing Refs

- `../../../contracts/021-checkpoint-diff-contract.md`
- `../../../contracts/023-task-backed-agent-workflow-contract.md`
- `154-task-review-source-snapshot-backend.md`

## Scope

- let the local chat workflow runtime own an explicitly configured snapshot
  backend supplied by the desktop host data root
- capture baseline after work-item scheduling and dispatch composition but
  before the Codex process starts
- fail closed without setting provider-execution-started when baseline capture
  is unavailable
- capture target only for completed runtime outcomes before awaiting review
- compare manifests into added/modified/deleted/metadata-only path records,
  exact counts, coverage, and concurrent-write notice
- persist neutral checkpoint and diff-summary records through existing state
  services
- add baseline, target, and diff refs to task work-item source and execution
  records without granting review acceptance or task completion
- move target/diff failure to recovery required and stop serial Goal execution

## Ordered Steps

1. Add snapshot backend configuration to `LocalCodexChatService` without
   widening `ServerStateService`.
2. Configure the desktop host snapshot root beside local state, not inside the
   project.
3. Insert baseline capture in `execute_goal_run_with` before runner invocation.
4. Persist the baseline checkpoint and work-item linkage.
5. On completed outcomes, capture target, compose the diff, persist target and
   summary, then transition to completed/awaiting-review evidence.
6. Preserve wait, cancel, fail, recovery, idempotency, and serial Goal stop
   semantics without fabricating targets.
7. Add runner-fixture tests proving ordering and per-task isolation.

## Acceptance Criteria

- the fake runner observes a persisted baseline before it is invoked
- a baseline refusal prevents process/provider start
- a completion has baseline, target, and diff refs before review readiness
- pre-existing files unchanged across the window do not appear in changed paths
- changes made inside the runner window do appear and carry task/work-item refs
- target or persistence failure becomes recovery required, never clean review
- each serial Goal task receives its own non-overlapping window
- existing mandates, task revisions, receipts, and provider restrictions hold

## Validation

- `effigy check:rust`
- focused local chat Goal/task execution tests through `effigy test`
- `cargo fmt --all -- --check`
- `git diff --check`

## Closure Evidence

- runner assertions observe the persisted baseline checkpoint, source ref, and
  execution record before the first provider-start callback
- failure fixtures prove an unconfigured/refused baseline invokes the runner
  zero times and a target hard-limit failure ends in recovery required
- two serial tasks produce separate source windows; pre-existing files remain
  absent while added, modified, deleted, and metadata-only changes are exact
- completed work sources contain two checkpoint refs and one diff ref before
  awaiting review; the execution record carries the same evidence ids
- full Effigy validation passes 2,136 tests with 10 skipped

## Stop Conditions

- baseline capture can occur only after provider start
- work-item source records cannot carry checkpoint/diff refs without breaking
  replay or revision semantics
- task completion or review acceptance becomes implicit
- a Goal run would continue after incomplete review evidence

## Next

Auto-start card 156 after exact task-window evidence is durable.
