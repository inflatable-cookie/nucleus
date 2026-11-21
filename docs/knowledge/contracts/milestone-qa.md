# Milestone QA

Status: active (nucleus#1475)
Audience: planners, operators

Milestone QA is an ordinary report-only Nucleus task that runs a repository's
own milestone selectors against one pinned commit and delivers a qualification
record. Nucleus no longer owns a QA runner: `project.qa.run` and `qa.schedule`
refuse with the replacement named, and this file owns that recipe.

The runner-neutral procedure is the Northstar milestone-qa skill; this file
holds only what Nucleus adds — the task shape, the export path and what still
reads old runs.

## The task

One task per qualification. Its brief opts into report-only work
(`queue.reportOnly: true`) and names the lane document the record belongs in
(`queue.reportLane`), with that lane attached to the task (Spec 050). It gets no
PR, no branch to merge and no reviewer. The worker's workspace is disposable, so
nothing the record depends on may live there.

Scope and selectors come from the repository, never from this file: read
`effigy.toml` (`effigy tasks`, `effigy --json --plan <selector>`) and
`AGENTS.md`. For this repository the milestone board is `check`, `qa:docs`,
`qa:northstar`, `test` and `test:timing`.

## Pin the revision

Record the exact commit before running anything, and refuse a moving tip or a
dirty tree:

```sh
git fetch origin main
git rev-parse origin/main          # the SHA every slice below is recorded against
```

Run from a clean checkout of that SHA (a detached worktree or fresh clone), not
the registered checkout and not the repository's integration checkout.

## Run each slice under a durable run key

Effigy names every run, and a run started with `--run-id` keeps a log another
session can read. One slice per key, so a slice that never ran is visibly
missing rather than folded into an aggregate:

```sh
effigy --run-id "qa-<sha7>-check" check
effigy --run-id "qa-<sha7>-docs" qa:docs
effigy --run-id "qa-<sha7>-northstar" qa:northstar
effigy --run-id "qa-<sha7>-test" test
effigy --run-id "qa-<sha7>-timing" test:timing
```

`effigy run status <key> --json` and `effigy run logs <key>` re-read a slice's
state, exit code, cleanup and retained log by key after a turnover. Copy a log
out with `effigy run logs <key> > <scratch>/<key>.log` when the record needs the
text, and keep the key in the record either way: the key is the durable handle,
a scratch copy is not.

Other runners follow the same shape: the milestone-qa skill's steps 2 to 4 name
what a run must expose (pinned SHA, declared scope, per-slice exit and counts,
retained handle).

## Export as each slice finishes

Write each slice into the task's lane document with `lane.document.edit` as soon
as it settles, sending the `version` you last read. The lane document is durable,
versioned and digest-fenced, so a worker that dies mid-milestone leaves every
finished slice behind and its successor re-runs only what is missing. Never
report a scratch path as evidence that outlives the run.

Each entry carries:

- the pinned SHA and the selector's declared scope;
- the slice and its exact selector or command;
- the run key, exit code and the test counts the runner printed;
- the retained log path or key, and any output cap that truncated it;
- execution or cleanup faults kept apart from the test result.

## The record

The delivered record answers the milestone-qa skill's step 4 in one place:
revision and scope; selectors and coverage, including any declared selector that
was skipped or not reached; `pass`, `fail` or `incomplete` with the runner's own
exit status and counts; execution and cleanup faults named separately; and the
logs plus durable run keys.

An infrastructure, log or teardown fault never overwrites a recorded test
result, and never turns an unfinished scope into a pass: unproved scope stays
`incomplete`. File repair work from a failing slice only once it is proven a
product or test regression at that SHA, naming the SHA, the slice and the log.

## Report

Report `report_ready` with `artifact: {key, version, digest}` for the lane
document version holding the record. The planner accepts it with `complete`, or
returns it with `move to=work` and an instruction. A report-only task starts no
reviewer and no blocker escalation.

## What Nucleus still serves

Retiring the launch left old runs alone. `project.qa.get` and
`project.qa.list` keep answering for stored runs, `project.qa.cancel` stops a
live one, `project.qa.retry-teardown` reruns a failed teardown, and
`project.qa.dismiss` clears a finished failure from the board without deleting
it. A run admitted before the cutover is still recovered by the supervisor, so a
roll neither loses it nor replays it. Those verbs are history and cleanup, never
a launch.

## Migration and removal order

1. **This cutover.** `project.qa.run` refuses for every caller and every
   `--wait` shape; `repository.set` refuses enabling or replacing `qa.schedule`
   and accepts `{"qa":{"schedule":null}}`; a repository that still has a
   schedule records one notice naming this recipe instead of admitting a run.
   In-flight runs, their recovery and all settled history are untouched.
2. **Per-consumer replacements.**

| Consumer | Retired state | Current state |
| --- | --- | --- |
| Planner habit and prompts | `project.qa.run` on `main` | a report-only task with this recipe |
| CLI `nucleus project.qa.run --wait` | managed run and settled summary | selector slices under named Effigy runs, record in the lane document |
| Board QA runs tab and QA card (PR #403, nucleus#1498) | `QA runs` tab with `Run QA`, project picker, and board `QaRunCard` (`Re-run`, `Dismiss`, `Cancel`, `Details`) | removed from the board (inbox board dropped the QA runs surface and filters QA cards; `QaRunsTab`/`QaRunCard` are deleted); legacy history and cleanup use `project.qa.list`, `project.qa.get`, `project.qa.cancel`, `project.qa.dismiss`, and `project.qa.retry-teardown`, while Planning keeps a read-only `ProjectQaLatest` summary without launch, cancel, or tab-link controls |
| `qa.schedule` per repository | automatic milestone admission | a planner-submitted report-only task per milestone |
| Settings → Projects QA fields (nucleus#1498) | `Schedule`, `After N merges`, and milestone `Timeout` controls | schedule and timeout controls removed; `QA` command (`qa.argv` / `qa.stages` for worktree validation evidence) and `Merge check` (`validation`) kept; `repository.set` still clears a leftover schedule via `{"qa":{"schedule":null}}` |
| Scheduled QA notices and reminders | planner notices from the schedule pass | ordinary task reporting; the leftover schedule notice is cleared by removing `qa.schedule` |
| Release and roll runbooks | "milestone QA remains `project.qa.run`" | this recipe at the release SHA |
| Cross-repository planners | briefs that call `project.qa.run` | a report-only task in that repository, same recipe |

3. **Deferred removal.** After no live install has an unsettled run or a
   schedule, a later change removes the supervisor and pipeline, the
   QA-only scheduling pass and its notices, and the
   managed-run storage and host-run classes. Historical runs stay readable until
   retention ages them, and removing the runner never removes the record of a
   qualification that already happened.

Never mutate a live install, a schedule, a stored run or its history as proof
that a step is safe.
