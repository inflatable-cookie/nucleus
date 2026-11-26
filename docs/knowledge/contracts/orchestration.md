# Orchestration contract

[Spec 070](../specs/070-small-engine.md) defines the Rust task lifecycle. This
contract owns its operating rules. The [service boundary](service-boundary.md)
owns process custody, client authentication and host access.

## Invariants

- Preserve task, repository, branch and PR identity across retries, revisions
  and recovery. Keep prior runs, verdicts and delivery evidence in history.
- Authenticate the current run before accepting its report. Revocation ends
  the run's ability to steer the task. It keeps custody of any possibly live
  turn until that turn settles.
- Record intent before a side effect. A timed-out or incomplete observation is
  unknown. Require positive evidence of absence, readiness or custody before
  creating, replacing, terminating or deleting anything that depends on it.
- Merge at the exact approved head or through authorized acceptance recorded
  for that same head. Remove a worktree only after a fresh custody and clean
  status check. These are the two [hard gates](../specs/070-small-engine.md#hard-gates).
- A brief and bound planner guidance define execution scope. A plan, lane
  document, PR comment, read projection or observed merge is evidence.
  Decisions requiring a planner or operator remain with that authority.
- Keep a blocked task owned. `next` explains its recorded wait and available
  commands. Describe a stuck case as a papercut. Generalize the lifecycle rule
  or use an existing exit, following [the repository working rules](working-rules.md).

## Daemon owners

The [core task model](../../../engine/crates/nucleus-core/src/model.rs) stores
task identity, brief version, phase, run, PR and verdict. The
[pure lifecycle decision](../../../engine/crates/nucleus-core/src/decision.rs)
uses the current state and observations to choose the next action. The
[service](../../../engine/crates/nucleus-service/src/lib.rs) serializes state
changes and coordinates work under the task fence. Its [scheduler pass](../../../engine/crates/nucleus-service/src/pass.rs)
owns external observations, deadlines and effects. The
[store](../../../engine/crates/nucleus-store/src/lib.rs) commits state with
its audit event. Plan, lane, item and decision writes use their
[planning owner](../../../engine/crates/nucleus-service/src/planning.rs).
Task, host and forge actions cross their own service interfaces.

### Shared task reads

The board, `next` and the native task row read the same durable task facts and
current attention state. The operator sees actions that require the operator.
Planner questions, capacity and scheduled retries keep their own waits.
Ordinary task and planning reads use local state. Preflight describes the
available action. Applying it rechecks the current record and any required
external evidence at the effect boundary. See [attention](../../../engine/crates/nucleus-service/src/attention.rs),
[task rows](../../../engine/crates/nucleus-service/src/task_rows.rs) and
[command decisions](../../../engine/crates/nucleus-core/src/command.rs).

## Identity and authentication

### Submission and instruction source

Admit one task from an approved brief or an eligible lead or papercut. Record
its repository, immutable identity, public per-repository reference and brief
version. A task may enter at review with a named external PR and exact head.
Check prerequisite identities before dispatch. A later brief edit creates a
new version through an authorized command. Lane evidence and history remain
available without expanding what the task may do. The [planning model](../specs/070-small-engine.md#planning-model-milestone-3)
sets the scope of plans and item promotion.

### Runs and callbacks

Reserve a distinct launch instance with a pinned role, profile, prompt and
credential. The task has a retained worker and an independent reviewer. T3
runs are children of the task's provider-neutral ACP session. Reuse the current
retained thread when its role, profile and custody allow it. A provider or
profile change may open a new child. Positive absence, rather than an unknown
read, can release a missing binding. Keep a revoked run fenced while any turn
may still be live. Accept one authenticated result for the run. An identical
replay can return the existing outcome, while a conflicting replay or wrong
review head refuses. See [launch handling](../../../engine/crates/nucleus-service/src/pass.rs),
[ACP parenting](../../../engine/crates/nucleus-hosts/src/parenting.rs) and
[report checks](../../../engine/crates/nucleus-core/src/command.rs).

## Dispatch and workspace

Admit eligible tasks in recorded order. Before entering Working, check the
current mode, prerequisites and global, project and checkout capacity. Apply
the same gate to report-only work. Repeat it before reserving the worker.
Pausing controls launches and leaves task commands available. Stop revokes
live runs and waits for settlement. Per-task holds keep their own scope and
reason. Preserve usage levels, profile selection and subscription pauses.
[Spec 052](../specs/052-usage-level.md) and [Spec 053](../specs/053-demand-based-selection.md)
own selection. Confirmed provider limits pause the eligible group, and a
manual suspension stays in force until an operator edit. See the
[scheduler](../../../engine/crates/nucleus-service/src/schedule.rs) and
[profile gate](../../../engine/crates/nucleus-service/src/profiles.rs).

Use the configured allocator and recorded checkout. Materialize siblings at
pinned `[sources]` revisions. The checkout, branch and run scratch are bound
before handing work to the worker. Follow [repository hooks](repository-hooks.md)
and [worktree handling](../../../engine/crates/nucleus-work/src/lib.rs).

### Wait states and prerequisites

Record first-dispatch prerequisites and deliberate post-dispatch waits as
separate task facts. Missing or cancelled prerequisite work needs an owner
edit. A hold and a dependency wait are independent. On release, the scheduler
observes current capacity and preserves the task's identity and order. The
[dependency owner](../../../engine/crates/nucleus-service/src/dependencies.rs)
and [Spec 070 commands](../specs/070-small-engine.md#commands) own the precise
updates and exits.

### Orphan worktree after a timed-out create

Use exact checkout and branch evidence before adopting or repairing a partial
create. Before any role is sent, the engine can quarantine a partially
initialized checkout under the task fence and allocate from the verified
start. Workspace observation errors receive the bounded recheck in
[Spec 070 ruling 37](../specs/070-small-engine.md#rulings).
After repairing the checkout, the owner can use Recheck at the version shown by Next. See the [worktree implementation](../../../engine/crates/nucleus-work/src/lib.rs).

## Worker run

[The Nucleus skill](../../../skills/nucleus/SKILL.md#run-protocol) owns shared
worktree, reporting and worker/reviewer instructions. AGENTS.md owns each
repository's validation and scratch rules. An assignment carries the held
brief, assigned branch, run facts, pinned context and authenticated report
route. Only relevant lane document versions travel with it. When the provider
lacks the matching installed role sections, the engine includes them. See
[prompt rendering](../../../engine/crates/nucleus-service/src/prompt.rs) and
[Spec 070 rulings 29 and 32](../specs/070-small-engine.md#rulings).

### PR identity from reports

A worker reports the real open non-draft PR and exact pushed head from its assigned
branch to its assigned base. Finding a branch or PR is evidence of identity.
A readiness report comes from the current worker. On continuation or revision,
keep the existing checkout, source custody and PR. A recorded same-head result
supplies context without substituting for new work or a new verdict. Report-only
work delivers the bound lane artifact at the exact key, version and digest.
Its planner accepts that version with `complete`. See
[report-only milestone QA](milestone-qa.md) and
[report verification](../../../engine/crates/nucleus-core/src/command.rs).

## Review

A reviewer independent of the author verifies the assigned exact head against
the brief using public source, the pinned checkout and required evidence. The
reviewer returns approving or change-requested findings through its bound
report route. A different head needs a fresh view and verdict. A changes
verdict can authorize a worker revision and a profile climb only once for the
matching review. Retained evidence helps the next review. A missing result or
incomplete review creates no approval. See the [Nucleus reviewer protocol](../../../skills/nucleus/SKILL.md#reviewer)
and [review decisions](../../../engine/crates/nucleus-core/src/decision.rs).

### Mechanical integration without repeated content review

The engine uses GitHub mergeability and required checks at the approved PR
head. The review stays with that head while its required checks settle. A new
head invalidates the old result for merging. There is no Nucleus integration
turn. See [Spec 070 ruling 13](../specs/070-small-engine.md#rulings) and the
[forge adapter](../../../engine/crates/nucleus-forge/src/lib.rs).

## Merge and closeout

### Merge gates

Merge uses the exact head last reviewed and approved, or exact-head acceptance
recorded by the authorized person. GitHub supplies the expected-head check
and required CI decision. A result that might have merged is reconciled by
observing the actual PR and merge commit before any further effect. Keep the
observed head, merge commit and reason with the task's outcome. See
[command authority](../../../engine/crates/nucleus-core/src/command.rs) and
[merge scheduling](../../../engine/crates/nucleus-service/src/pass.rs).

### Manual merges of Nucleus PRs

Before merging a Nucleus PR by hand, fetch `origin/main` and merge its tip with
the reviewed PR head in a scratch checkout. For each affected Rust crate, run
`effigy engine:check --tests -p <crate>` on that tree. If main has moved since the
PR's checks ran, also run `effigy engine:clippy -p <crate>` there. Record the
base, head and tested tree. Recheck the base immediately before merging at the
exact head. If the base moved, rebuild the merge result and repeat the checks.

### Owner acceptance

The responsible planner can explicitly accept an observed external merge for
an ordinary brief. A review-entry acceptance belongs to the operator. Record
the exact observed head and reason. The affected PR remains the task's PR.
See [Spec 070 hard gates](../specs/070-small-engine.md#hard-gates).

### Operator source acceptance

An operator acceptance is tied to the exact observed head and recorded actor.
Native Inbox forms currently record an unattested response because T3 cannot
attest the responder. Workers and reviewers leave operator forms to the
operator. An operator's decline parks the task and notifies its planner once. Keep decisions
that grant lifecycle authority in the recorded action. See the
[native Inbox owner](../../../engine/crates/nucleus-service/src/native_inbox.rs)
and [Spec 070 rulings 26 and 27](../specs/070-small-engine.md#rulings).

### External merge

An observed external merge supplies forge evidence. The task may close under
its existing exact-head approval, or after the authorized acceptance above.
Observation alone supplies no authorization to close an unreviewed task.

## Durable effects and unknown delivery

Freeze the target, scope and exact command identity before a possible external
send. Reconcile a doubtful outcome against the native receipt, current thread,
forge or worktree. Replay only the same operation identity when the destination
can deduplicate it and the current evidence still authorizes that action. A
revoked reservation can reconcile and settle its delivery. It cannot launch a
fresh turn. A newer run retains its own custody. See the
[scheduler effects](../../../engine/crates/nucleus-service/src/pass.rs),
[native command boundary](../../../engine/crates/nucleus-hosts/src/launch.rs)
and [Spec 070 decisions](../specs/070-small-engine.md#the-decision-table).

### Uncertain creation and explicit exits

A receipt and bounded native read can prove which role launch occurred. Until
that evidence settles, the engine holds the owning reservation. An unresolved
send without a safe replay stays with the task. Its wait and `next` show the
reason and current exit. A role or launch fenced by an owner command can be
replaced only once its custody is settled. The
[Spec 070 fault rules](../specs/070-small-engine.md#faults) own when to retry and
when to ask the planner.

## Cleanup

### Terminal workspace cleanup

Archive a terminal task’s exact idle thread from its synchronized T3 project, worktree and branch binding. Recheck Dispatch and the idle thread at the write. The registered directory may have moved.
The board and Next retain the workspace outcome. Before removing a checkout,
verify idle participants in the held shell, Dispatch, the Git registration and
published head. Each pass shares one census of the local user’s working
directories. A PID in the checkout or run scratch holds removal and appears in
the wait detail. At terminal closeout, Nucleus stops a process tree rooted in the checkout
or the task’s recorded run scratch and orphaned to PID 1 and records the signal outcomes in task history. Host
processes and their descendants stay protected. An incomplete census keeps
the checkout.
For a retained Done code checkout, read the merged PR again and match its
head to the task’s recorded head. An unavailable read leaves the checkout in
place. The task and project fences span removal. Clean worktrees and checkouts
with only unstaged deletions of files at that exact published head retire by
atomically renaming the directory into same-volume trash under the work root,
removing the Git worktree registration, and deleting the trash asynchronously.
An interrupted cleanup whose `.git` file was already unlinked still proves
custody through its matching prunable Git registration. Git-ignored output goes
with the checkout. Modified, added, non-ignored untracked or uncertain contents
retain it. A cancelled task retires a clean or deletion-only checkout once its
HEAD is proved published on an origin branch.
Already archived, absent and deleted threads count
as settled. An active thread waits. See [Spec 070 rulings 34 and 35](../specs/070-small-engine.md#rulings)
and [worktree custody](../../../engine/crates/nucleus-work/src/lib.rs).

### Published source

Observe the exact published branch, PR head or merge commit before destroying
its local source. A report-only run archives its delivered evidence in its
bound lane. Unpublished changes and uncertain source stay in the checkout.
See [report-only cleanup](../../../engine/crates/nucleus-service/src/report_only.rs).

### Terminal participant liveness

Take native activity and workspace process evidence from the current checkout
and task identities. A failed, incomplete or timed-out probe leaves liveness
unknown. A recorded finish does not by itself excuse checking a potentially
live participant before destructive cleanup.

### Owned-tool evidence

Use bounded process observations for the checkout that a task owns. Refuse a
cleanup that depends on a process probe when the probe cannot establish the
fact. Scope termination to a proven participating run. The
[host process reader](../../../engine/crates/nucleus-hosts/src/process.rs)
and [Spec 070 rulings 11 and 35](../specs/070-small-engine.md#rulings) own this
boundary.

## Historical procedures

<a id="progress-checkpoints"></a>
<a id="source-immutable-proof-executor-ruling"></a>
<a id="non-converging-review-ladder-spec-058-cutover-3"></a>
<a id="workspace-archive-retry"></a>

[Spec 070](../specs/070-small-engine.md#rulings) owns the cutover rulings. The
prior contract preserves the TypeScript procedures for
[checkpoints](https://github.com/inflatable-cookie/nucleus/blob/737246d22bcb7590e5819da41449d28131ed1b3d/docs/knowledge/contracts/orchestration.md#progress-checkpoints),
[proof execution](https://github.com/inflatable-cookie/nucleus/blob/737246d22bcb7590e5819da41449d28131ed1b3d/docs/knowledge/contracts/orchestration.md#source-immutable-proof-executor-ruling),
[the planner ladder](https://github.com/inflatable-cookie/nucleus/blob/737246d22bcb7590e5819da41449d28131ed1b3d/docs/knowledge/contracts/orchestration.md#non-converging-review-ladder-spec-058-cutover-3)
and [workspace archive retry](https://github.com/inflatable-cookie/nucleus/blob/737246d22bcb7590e5819da41449d28131ed1b3d/docs/knowledge/contracts/orchestration.md#workspace-archive-retry).

### Archived task threads

Housekeeping checks T3's archived shell on the Dispatch retention interval
(default 12 hours). It drains the eligible set in batches of up to 32, oldest first. Each batch
uses a fresh inventory on a scheduler scan at least 30 seconds after the previous
claim. The interval starts again after the final batch. Eligible threads are parents, workers
and reviewers recorded for finished Rust tasks. The archive must be older than
the configured retention (default three days). A live task or origin binding
protects the thread. Dispatch must be running, and a changed archive is checked
again on a later pass. An uncertain write keeps its command ID and requires
fresh archive evidence before another attempt, up to three retries.
