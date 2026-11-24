# Milestone QA

Status: active
Audience: planners, operators

Milestone QA is an ordinary report-only Nucleus task that runs a repository's
own milestone selectors against one pinned commit and delivers a qualification
record. The repository runner executes the selectors and retains their evidence.

The runner-neutral procedure is the Northstar milestone-qa skill; this file
holds only what Nucleus adds — the task shape, the export path and what still
reads old runs.

## The task

One task per qualification. Its brief opts into report-only work
(`queue.reportOnly: true`) and names the lane document the record belongs in
(`queue.reportLane`), with that lane attached to the task (Spec 050). It gets no
PR, no branch to merge and no reviewer. The worker's workspace is disposable, so
nothing the record depends on may live there. The Rust engine grants the run
ticket access to only the delivery lane. A brief without `queue.reportLane` can
use its sole attached lane. If it attaches more than one, the planner must name
the delivery lane (Nucleus planner, 2026-11-24).

Scope and selectors come from the repository, never from this file: read
`effigy.toml` (`effigy tasks`, `effigy --json --plan <selector>`) and
`AGENTS.md`. The Rust selectors cover the workspace. The TypeScript test slice
covers the active entries in `scripts/active-tests.json`.

## Pin the revision

Record the exact commit before running anything, and refuse a moving tip or a
dirty tree:

```sh
git fetch origin main
git rev-parse origin/main          # the SHA every slice below is recorded against
```

Run from a clean checkout of that SHA (a detached worktree or fresh clone), not
the registered checkout and not the repository's integration checkout.

On the Rust engine, `task.add --planning-commit <sha>` checks the requested pin
against the published integration tip. The registered repository must already
have the commit available to Git. The worker's allocated checkout starts at the
recorded pin.

## Run each slice under a durable run key

Effigy names every run, and a run started with `--run-id` keeps a log another
session can read. One slice per key, so a slice that never ran is visibly
missing rather than folded into an aggregate:

```sh
effigy --run-id "qa-<sha7>-engine-fmt" engine:fmt
effigy --run-id "qa-<sha7>-engine-check" engine:check
effigy --run-id "qa-<sha7>-engine-clippy" engine:clippy
effigy --run-id "qa-<sha7>-check" check
effigy --run-id "qa-<sha7>-docs" qa:docs
effigy --run-id "qa-<sha7>-northstar" qa:northstar
effigy --run-id "qa-<sha7>-engine-nextest" engine:nextest
effigy --run-id "qa-<sha7>-test" test
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
finished slice behind and its successor re-runs only what is missing. Keep
evidence that outlives the run in the lane or runner logs.

The Rust engine's worker prompt supplies the run-ticket forms of `lane.get`
and `lane.put`. Read the document and its version, send the updated Markdown
with that version, and keep the artifact returned by the edit. If another
writer advances the lane, re-read it before applying the next slice.

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
reviewer and no blocker escalation. On the Rust engine, task detail shows the
delivered artifact and offers Complete and Return to work. Completion takes
the exact delivered version even if the lane has since advanced. The engine
archives the workspace after custody and Git publication checks pass.

## Legacy history and upgrades

`project.qa.get` reads a saved run by ID or the latest run for a repository.
`project.qa.list` lists the latest saved run per repository.
`project.qa.request-status` reads stored request identities. These reads use
durable history, so an offline checkout does not prevent an exact-ID read.
Result records, step logs and failure logs keep their established retention.
The live store's evidence lives on its configured `projectQaRoot` (default
`<workRoot>/archives/nucleus-project-qa/`), and custody and retention also read the
retired `<workRoot>/queue/project-qa/` location while an existing install's files
are still there (nucleus#1526).
Lane document versions remain the qualification record for report-only tasks.

`project.qa.run` also refuses the old `--wait` form and points callers to this
recipe. Stored schedules are inert. Clear a leftover schedule with
`repository.set` and `{"qa":{"schedule":null}}`. A schedule-only clear preserves
the repository's validation evidence commands. Enabling a schedule is refused.

The roll checks stored QA custody before warm standby takes the live socket and
again before the replacement opens the writable store. The cold start does the
same check. The latest-run index cannot hide an older unresolved run. Custody
is live evidence: an unfinished run, an unresolved request, an unsettled host
reservation, an active fence, a live QA process or a checkout still on disk
defers takeover. A finished run's dead pid, cleanup flag or checkout path on a
root that no longer exists holds nothing. The check reads store and filesystem
evidence and leaves records, processes and checkouts in their current custody.

Settle an older occurrence on the compatibility build, the build that refused
new launches and still recovered legacy runs. Use that build's
`project.qa.fence-status` and `project.qa.request-status` to inspect it, then
use its existing cancellation, teardown retry or retention path as applicable.
Wait for a fence to expire or clear it there with the existing authority.
Retry the roll after settlement. An installed bridge that predates the
deferral status shows the startup refusal as a failed roll and suppresses that
candidate until main advances. After compatibility cleanup, that owner retries
when it sees the next main revision. The refusal names the custody issue.

The board, Planning and task detail show report-only milestones through the
ordinary task workflow. Generic host runs and merge-time validation still use
their own run records and retention.
