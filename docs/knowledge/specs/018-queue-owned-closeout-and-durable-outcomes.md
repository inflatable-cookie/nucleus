# 018 — Nucleus-owned closeout and durable outcomes

Status: implemented
Owner: Nucleus runtime and protocol maintainers
Created: 2026-09-25
Decision owner: Tom
Governing refs: Northstar Spec 042 (lean Northstar, approved 2026-09-25),
[orchestration](../contracts/orchestration.md),
[repository hooks](../contracts/repository-hooks.md),
[terminal closeout projection](006-terminal-closeout-projection-convergence.md)

## Problem

Northstar Spec 042 moves task state, briefs, review and closeout out of
repositories and into the orchestrator. Nucleus piloting that needs two things it
lacks today.

1. **No closeout that writes nothing.** `classifyCloseoutAuthority` picks `hook`
   when the manifest binds a required integration-write `task.closeout` hook,
   and falls back to `agent` otherwise. Both write to the repository. A
   repository that keeps no process records has no correct choice.
2. **Nucleus forgets.** `Store.purgeOldTasks` deletes a finished task 4 days (Tom, 2026-10-20, relayed by the Project-c Supervisor: "4 days for queue"; previously 14)
   after it ends, with its events, runs and notices. It keeps only a tombstone:
   id, submission, title, phase, removed and held. That is harmless while the
   repository holds the lifecycle record, handoff and log. Under Spec 042 it
   would leave no record anywhere that the work happened.

This spec covers Spec 042 items 1 and 4a. Briefs stored in Nucleus (item 2),
plain-validation pre-merge checks (item 3) and the outcome query surface (4b)
follow in their own specs.

## Manifest v5

`paseo.queue.control.v5` is a new schema version. v1–v4 are unchanged, and
every repository on them keeps its current behaviour.

```json
{ "schema": "paseo.queue.control.v5", "closeout": "queue", "hooks": [] }
```

- `hooks` takes the v4 hook definitions unchanged and may be empty.
- `closeout` is `"queue"` or `"hooks"`, default `"hooks"`. `"hooks"` means the
  v4 selection: `hook` authority when a required integration-write
  `task.closeout` hook is bound, otherwise `agent`.
- `closeout: "queue"` with any hook bound to `task.closeout` is an invalid
  manifest. Two closeout authorities is ambiguous; it is refused like any other
  invalid manifest, never resolved by precedence.
- `validation` is reserved for Spec 042 item 3. Until that ships, a v5 manifest
  containing it is refused with a message naming the missing capability, not
  silently ignored.
- The schema stays strict, like v1–v4.

Nucleus already reads the manifest at each event's base commit. Closeout authority
is read at the task's synchronized commit, so a repository switches per commit.
A task that closes at a base carrying the v5 manifest gets Nucleus closeout, even
if it was dispatched under v4. A task closing at an older base keeps the
authority that base names.

## Nucleus closeout

`closeoutAuthority` returns `"queue"` for a v5 manifest with
`closeout: "queue"`.

After merge verification and main synchronization, a Nucleus closeout:

- creates no closeout run, closeout workspace, hook occurrence, isolated checkout
  or commit, and pushes nothing;
- writes the durable outcome row (below) and moves the task to `done` in one
  store transaction, with the synchronized commit as `syncedCommit`;
- sends the existing completion notices and runs the workspace archive pass,
  which records per-workspace retry backoff and keeps the failure cause visible
  on the board;
- is skipped by closeout-workspace recovery, as hook closeout already is.

Closeout faults that belong to hooks or agents cannot happen here. A task already
held on a hook or agent closeout when its repository switches keeps that
authority until it settles. The switch applies only to closeouts that start at a
v5 base. That matters little in practice, because the Consumer-b switch happens
after its drain, with nothing in flight.

## Workspace archive retries

A failed archive stores its attempt count, cause and next retry time against the
exact workspace ID. The delay starts at one minute, doubles after each failure
and caps at one hour. The state is durable across restarts. An uncertain archive
intent is observed before Nucleus reissues the same idempotent archive request;
that observation and any reissue wait until the workspace's retry deadline.
Success clears only that workspace's retry record. A failure on one owned
workspace does not prevent Nucleus from archiving another owned workspace in the
same pass. The completed task stays visible on the board with the archive cause,
attempt count and next retry time until its workspaces are archived.

## Revision: the retention purge carries hook occurrences (2026-10-25)

The purge deleted every per-task table by name except `hook_events`, so 10,460
occurrences of purged tasks stayed behind, 40 MB of the store, and the hourly
reaper recorded one "Task history was purged" error per orphan. Hook records are
the only proof of ownership for an isolated checkout, so the fix is an order,
not a broad delete (audit B5):

- **Reap first.** The daily pass lists the tasks the purge would delete, reaps
  their owned checkouts with the ordinary reaper, and only then purges.
- **Gate on ownership.** A task is skipped — not purged — while any occurrence
  still names a checkout that exists, or is in a state whose delivery never
  settled. `uncertain` is not settled here even where the reaper may dispose of
  it: unknown delivery is never read as gone. A settled occurrence that records
  no checkout is Nucleus's own statement that it holds none, because every path
  clears the handle only after removing the directory.
- **Then delete.** A task that passes the gate loses its `hook_events` rows with
  its events, runs and notices.
- **Orphans.** An occurrence whose task is already gone is reconciled only when
  its own recorded checkout is positively absent; one whose path exists or
  cannot be read is kept and stays visible in the reaper's health.
- **Nothing else moves.** Outcomes, tombstones, operations and the retention
  window are unchanged, and no version of this deletes a path it cannot prove
  Nucleus owns.

## Durable outcome record (4a)

A new `outcomes` table, one row per terminal task, keyed by task id. The row is
written in the same transaction as the terminal transition, for every terminal
path: Nucleus, hook and agent closeout, cancellation, supersession and removal of
a finished task. `purgeOldTasks` never deletes it, and nothing else does either.

| Field | Content |
| --- | --- |
| `taskId`, `submissionId` | Nucleus identities |
| `title` | Task title |
| `repository` | Normalised origin (`owner/name`), plus the local path as a hint only |
| `outcome` | `done`, `cancelled` or `superseded`, with `replacementTaskId` when superseded |
| `reason` | Terminal summary |
| `pr` | URL, number and final reviewed head, when there was a PR |
| `mergeCommit`, `syncedCommit` | When merged |
| `review` | Final review status and summary, and the review comment id |
| `validation` | Pre-merge and mechanical verification result summary, when present |
| `closeout` | Authority used (`queue`, `hook` or `agent`) and the published hook or closeout commit, when any |
| `brief` | Digest, media type and full text of the brief the task ran (today the pinned handoff text) |
| `workers`, `reviewers` | Profile and model identities, without Paseo agent ids |
| `startedAt`, `finishedAt` | Timestamps |

The record is host-neutral: no Paseo agent, workspace or run ids, so Nucleus can
adopt the schema unchanged. Nucleus's live tables keep those ids.

**Backfill.** When the table is created, every `done` or `cancelled` task still
in the store gets a row derived from its current data, marked
`backfilled: true`. Tasks already purged have only their tombstone, and no row is
invented for them.

**Read access.** An RPC and CLI read by task id or submission id, returning the
row after the task itself has been purged. Search ("what landed for X") is 4b.

## Contracts and specs changed

- Contract 005: the v5 schema, `closeout`, the reserved `validation` key and the
  invalid combination.
- Contract 003: closeout authority now has three values, and the outcome row is
  part of the terminal transition.
- Spec 006: marked as applying only to repositories that choose hook closeout.
  Nucleus closeout never enters it.
- Retention policy (store and README): live-task purging is unchanged, and
  outcome rows are permanent.

## Acceptance oracle

Each row needs a named test or fixture.

| # | Scenario | Required result |
| --- | --- | --- |
| 1 | Repositories on v1–v4, including no manifest | Authority, hooks and closeout exactly as before |
| 2 | v5 `closeout: "queue"`, task merges and syncs | `done` with no closeout run, workspace, hook occurrence, commit or push; outcome row committed in the same transaction |
| 3 | Dispatched under v4, closes at a v5 base | Nucleus closeout |
| 4 | Dispatched under v5, closes at a base reverted to v4 | v4 authority |
| 5 | v5 `closeout: "queue"` plus any `task.closeout` hook | Refused as an invalid manifest; no closeout occurs |
| 6 | v5 manifest containing `validation` | Refused with the item-3 message |
| 7 | v5 `closeout: "hooks"` | Identical to the same hooks under v4 |
| 8 | Outcome row after `purgeOldTasks` removes the task | Row intact and readable by task id and submission id |
| 9 | Cancellation, supersession, removal of a finished task | One row each, with the right outcome and no merge fields |
| 10 | Crash before and after the terminal transaction | Either no row and not done, or both; restart never duplicates or rewrites a row |
| 11 | Migration on a store with existing done and cancelled tasks | Backfilled rows, marked; purged tasks get none |
| 12 | Hook and agent closeouts | Outcome row carries their authority and published commit |
| 13 | Brief content | Equals the task's pinned brief text byte for byte, with its digest |
| 14 | Paseo workspace archive fails | Cause is retained with a one-minute retry deadline; another pass before the deadline does not call Paseo again |
| 15 | One of two owned workspaces fails archive | The other workspace still archives and each workspace keeps independent retry state |
| 16 | Nucleus restarts with a failed archive | Attempt count, cause and deadline survive; an uncertain archive is observed before its idempotent reissue |
| 17 | A retry succeeds | That workspace's retry state clears; the task leaves the board once no cleanup remains |

## Out of scope

Briefs as submission content (item 2), plain-validation pre-merge (item 3),
outcome search and UI (4b), any repository manifest change, and the Northstar
skill and hook bridge.
