# Nucleus engine build plan

[Spec 070](../docs/knowledge/specs/070-small-engine.md) owns the model. Milestone 1
runs one synthetic task from work through closeout on T3. The Rust engine is off
by default, uses its own settings and database, and admits only the explicitly
configured fixture repository. The planner checks the run by hand. The board
switch starts in milestone 2.

## Crates and review slices

| Slice | Crates | Boundary |
| --- | --- | --- |
| 1 | `nucleus-core` | Typed task, commands, transitions, pure `decide`, and a test for every decision arm and both gates. |
| 2 | `nucleus-store`, `nucleus-work` | SQLite task and history transactions, settings paths, and worktree allocation and retirement. |
| 3 | `nucleus-forge` | GitHub PR identity, exact-head checks, merge and merged-head readback. |
| 4 | `nucleus-hosts` | A small host interface and the authenticated T3 adapter, tested against RPC fixtures. |
| 5 | `nucleus-service`, `nucleus-cli` | Serialize decisions, callbacks and commands per task. Expose the read model and run an isolated service and CLI. |

Keep PRs near 1,500 changed lines plus tests. Open each against `main` once its
dependencies land. The planner arranges independent review and merges. Run
formatting, check, strict Clippy and nextest for changed crates through Effigy,
with a shared Cargo target under `NUCLEUS_SCRATCH_ROOT`. Oxide uses its registered
removable pool and refuses a pool path inside the task's Stash scratch directory.
Cargo deny and the whole workspace run at milestone QA. The fixture exercises
success, a stopped run, and readback after uncertain delivery before the
planner's live check.

Use the `v0.5.0` Longhorn git tag with `publish = false` for workspace packages.
`longhorn-config` owns the versioned engine and Storage settings domains, atomic
updates and config backups. `longhorn-storage-layout` resolves their roots and
the separate engine data root. `longhorn-git-workspace` reads identity and
cleanliness and supplies the bounded Git executor. `nucleus-work` owns allocation
and uses explicit `git worktree add/remove` without force. `longhorn-redact` and
`longhorn-support-log` cover adapter diagnostics. `longhorn-operation` leaves
persistence, deduplication and restart recovery to the caller, so it adds no
needed behavior here. Use `longhorn-update-install` when verified distribution
and roll enter scope.

Worktrees default to `<workRoot>/<repo-hash>/ns-<task-id>`. Barge's `barge` library
provides optional lease, lookup, hold and return. The fixture uses `workRoot`.
The Barge checkout has the worktree API and no release tag. Enable the pool
setting after a compatible dependency pin and a hold that covers the T3 turn
and its tools are available. `existing_worktree` passes a path to T3 and carries
no Barge hold. A Rust service-side hold survives neither its own crash nor a
tool left behind by T3. For both backends, inspect cleanliness just before
retirement and keep dirty or unpublished local work in place.

## State and decisions

The engine stores the latest task state in a dedicated SQLite database. First
schema, with the compact nullable fields encoded as typed JSON objects or SQL
`NULL`:

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, reference TEXT NOT NULL,
  repository TEXT NOT NULL, base TEXT NOT NULL,
  entry TEXT NOT NULL CHECK (entry IN ('brief','review_entry')),
  brief TEXT NOT NULL CHECK (json_valid(brief)),
  phase TEXT NOT NULL CHECK (phase IN
    ('queued','working','reviewing','merging','closing','done','cancelled')),
  threads TEXT NOT NULL CHECK (json_valid(threads)),
  run TEXT CHECK (json_valid(run)),
  pr TEXT CHECK (json_valid(pr)),
  verdict TEXT CHECK (json_valid(verdict)),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  question TEXT CHECK (json_valid(question)),
  hold TEXT CHECK (json_valid(hold)),
  UNIQUE (repository, reference)
) STRICT;
CREATE INDEX active_tasks ON tasks (id)
  WHERE phase NOT IN ('done','cancelled') OR run IS NOT NULL;
CREATE TABLE events (
  sequence INTEGER PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
  at INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL
) STRICT;
CREATE INDEX task_history ON events (task_id, sequence);
```

Use WAL and transactional schema versioning. Store the brief's text, version
and digest together. Store a human acceptance, when needed, as an exact-head
alternative in the verdict slot, including the accepting actor and authority.
Resolve the task's planner through repository settings. Append audit history in
the state transaction. The pass loop only reads active task rows. API history
and live notifications may read the event log.

Normalize the relevant observations to one signal per phase. The bound run
takes precedence over downstream work until its turn is quiescent. A required
unknown read yields a wait before any action that depends on it. Optional and
irrelevant reads do not delay a task. In this sketch `Remaining` is derived from
the current phase and head's failure count, and `Last` means the observed
failure is the third.

```rust
match (phase, run_state, observation) {
    (_, Revoked, Quiescent) => Advance(phase), // clear the revoked run
    (_, Revoked, _) => Wait(reason, retry_at),   // reconcile the stop
    (Done | Cancelled, _, _) => Nothing,
    (_, _, Held | QuestionOpen) => Wait(reason, None),
    (_, _, Unknown) => Wait(reason, retry_at),
    (_, Bound(_), Permission | Input) => Wait(reason, retry_at),
    (_, Bound(_), Starting | Running | IdleWithoutTerminalRun) => Wait(reason, retry_at),
    (Working | Reviewing, Bound(role), Failed(Remaining)) => Relaunch(role),
    (Working | Reviewing, Bound(_), Failed(Last)) => Ask(retry_question),
    (Queued, Unbound, Ready) => Advance(Working),
    (Working, Unbound, WorktreeReady) => launch(Worker, retained_thread),
    (Working, Bound(Worker), ReadyForReview) => Advance(Reviewing),
    (Working, Bound(Worker), WorkQuestion) => Ask(question),
    (Working, Bound(Worker), HandoffNeedsRepair) => Ask(repair_question),
    (Reviewing, Unbound, OpenPrAtHead) => launch(Reviewer, retained_thread),
    (Reviewing, Bound(Reviewer), ApproveAtHead) => Advance(Merging),
    (Reviewing, Bound(Reviewer), ChangesAtHead) => Advance(Working),
    (Reviewing, Bound(Reviewer), WorkQuestion) => Ask(question),
    (Reviewing, Unbound | Bound(Reviewer), HeadChanged) => Advance(Reviewing),
    (Reviewing | Merging, Unbound, PrNeedsRepair) => Ask(repair_question),
    (Merging, Unbound, OpenHeadNeedsReview) => Advance(Reviewing),
    (Merging, Unbound, ApprovedButPending) => Wait(reason, retry_at),
    (Merging, Unbound, ApprovedButBlocked) => Ask(repair_question),
    (Merging, Unbound, ApprovedAndReady) => Merge,
    (Working | Reviewing | Merging, Unbound, MergedWithAuthority) => Advance(Closing),
    (Working | Reviewing | Merging | Closing, Unbound, MergedNeedsAcceptance) => Ask(accept_question),
    (Closing, Unbound, ClosureReady) => Close,
    (Closing, Unbound, NoConfirmedMerge) => Ask(repair_question),
}
```

In Rust, the phase, run and adapter observations produce a typed signal for
the exhaustive decision match. A successful callback
waits for a terminal turn before advancing. A changed head also waits for the
old turn to end or be stopped before resetting the review. Confirmed non-delivery,
authoritative disappearance of a previously launched run, and a terminal run
without a report are failures. Transport and snapshot uncertainty advance no
counter. On launch or relaunch, continue the retained role's exact thread after
an idle read. Create only on first launch or after confirmed disappearance.
Wait for busy or unreadable threads. A changed head or phase resets attempts.
An explicit `move` also resets them when the phase and head stay the same. A worker
revision must produce a new PR head before another review. An external merge during a turn is processed
after the run settles. `Close` finishes only after fresh merged-head evidence and
workspace inspection. Dirty or unpublished work is retained and shown at closeout.

The commands mutate the same row. `hold` and `release` toggle the hold,
`amend` versions the brief, and `answer` resolves the current question. `move`
and `cancel` revoke the run credential immediately. The pass loop reconciles
the stop before releasing the workspace or starting another run. Direct moves
never give a head merge authority. The merge and clean-worktree gates also
apply to manual commands.

## T3, reports and GitHub

- Get a ticket with `POST /api/auth/websocket-ticket/rpc`, then open `/ws`
  with `orchestrationProtocol=2`. Use `server.getConfig` to check the configured
  provider and model. Pre-register the single fixture project for milestone 1.
- `orchestration.launchThread` takes explicit command, thread and initial-message
  IDs and `existing_worktree`. Bind the run and immutable launch inputs before
  sending. The task assigns a monotonic launch instance and derives a fresh
  bearer from it. Derive native IDs from the persisted instance. Before any send,
  read that exact native thread. Adopt a matching thread that already exists.
  Retry the same request after proven absence and when the earlier write can no
  longer land. Keep an unreadable or in-flight request unknown. Before sending a
  prepared review, re-read the open PR and clean checkout at the exact head.
- `orchestration.subscribeThread` with `requestCompletionMarker` and
  `acceptBoundedSnapshot` supplies the run, pending input and terminal state.
  Require exact thread identity and a complete observation. Use one shared
  `orchestration.subscribeShell` connection if needed for project and thread
  lookup. An absent shell entry alone cannot prove the thread is gone.
- `orchestration.dispatchCommand` with `message.dispatch` starts a new turn in
  a retained, idle thread. Verify the stable message ID before sending again.
  `thread.stop` stops the observed run on
  the engine-owned thread. Re-read it before releasing the checkout. T3's
  receipts bind a command to its thread but can accept a different body for the
  same pair. Keep the original request immutable locally. T3's existing one-row
  UX needs an ACP parent, `delegated_task.request` with a live parent run and
  root node, and `delegated_task.completion-delivery.dispose`. Milestone 1's
  standalone threads are for the fixture only. One row per task is an entry
  requirement for milestone 2.
- The role runs call a local authenticated report endpoint via an owner-only
  ticket outside the checkout. The prompt names the ticket path. The service
  verifies the task, role, current run, credential and requested review head.
  A worker sends its PR and head or a question. A reviewer sends its verdict,
  exact head and summary or a question. The same callback is harmless when
  retried while its run is current. Stale credentials cannot change task state.
- Read the GitHub PR against the task's repository, base and branch. Read
  mergeability, draft status, exact-head checks and review requirements. A
  separate reviewer turn examines the requested commit. Milestone 1 uses its
  authenticated verdict as Nucleus approval. Branch protection remains in
  force. Formal GitHub review publication needs a separate reviewer identity
  on repos that require it. Merge with `PUT /repos/{owner}/{repo}/pulls/{n}/merge`
  and the reviewed `sha`. On a lost response or head mismatch, read the PR
  again. Use `merged` and its merge commit for readback, including squash merges.
  An externally merged head with no verdict requires recorded human acceptance.
  [GitHub's exact-head merge endpoint](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request)

## Board

Define the JSON model from the engine. A task list returns identity, phase and
current wait or question. Detail adds the brief, current run, PR, verdict,
hold and paged event history. A `next` read returns the current phase, wait,
question and available commands. A typed command endpoint handles `move`,
`answer`, `cancel`, `amend` and `hold`/`release` using the same service as the
CLI. Authorized settings reads and writes expose the engine selection for new
tasks, work and scratch roots, optional Barge pools and role profiles. Keep
session and callback credentials separate. A scoped SSE channel signals task
and settings changes so the board can refetch current projections. Send an
invalidation on reconnect so delivery gaps need no event or replay queue.

| Keep | Reshape | Remove from Rust tasks |
| --- | --- | --- |
| `client/web` shell and T3 theme, sidebar shades, board layout and common controls | `client/queue.tsx` and `client/board` read the new list. Queued, Working, Reviewing, Merging and Closing map to phase groups. Done and Cancelled appear in history. | Incident, wait and recovery record cards. A task shows its current wait and hold. |
| Task panel shell and activity layout | `client/task` shows brief, current role/thread, PR/head, verdict, hold and history. `next-section` shows the reason and the five commands. | Explicit-command and proof buttons, effect retry, specialised routing and closeout controls. Use `move`, `cancel`, `amend` and `hold`/`release`. |
| Inbox layout and shared question controls | The Inbox shows the task's one question and lets the assigned planner submit `answer`. | Ladder rungs, escalations and recovery ownership. One question goes to the assigned planner. |
| Settings shell and Storage form controls | Settings and Storage read the Rust domains. `client/web` transport and live channel adapt at the data boundary. | Legacy per-task tuning and recovery settings. Planning records and legacy features keep their current route while the old engine drains. |

## Milestone 1 proof

Create the authorized private synthetic repository and its own T3 project when
the engine is ready to run. Keep the service disabled for everything else. Use
a real guarded merge and verify task state, exact heads, T3 turn settlement,
merge commit and worktree disposition by hand with the planner.
