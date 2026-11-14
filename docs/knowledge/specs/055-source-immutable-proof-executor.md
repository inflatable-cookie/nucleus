# 055 — Source-immutable author-side proof execution

Status: implemented
Owner: Nucleus runtime maintainers
Created: 2026-10-24
Decision owner: operator (Tom, 2026-10-24): answered decision
`199cdff3-2ef2-42ff-99b6-3b40f3d9722a` v2, verbatim "Build a Queue proxy
feature", relayed Supervisor `5164bf37-8e95-4d2b-82f1-8fcc6d367146` in
`80751f25-e514-4685-a140-1fe7c6165a19`.
Governing refs: [orchestration contract](../contracts/orchestration.md#source-immutable-proof-executor-ruling),
[050](050-owner-task-controls.md) (owner verbs), [054](054-required-proof-admission.md)
(required proof stays an admission subject), [017](017-external-pr-review-entry.md)
(external review entry), [036](036-role-reassignment.md) (review independence),
[013](013-standalone-queue-service.md) (durable operations).

## Problem

A manual or external source author can publish a PR and enter Nucleus through
review entry without any supported heavy launch route. Their brief may name one
author-side native proof ("ONE author-side native plus ONE distinct independent
reviewer native"), and nothing in Nucleus could execute it: no role, phase,
operation or receipt represented an author-side proof, and the review-entry
route deliberately refuses to adopt the source author as a worker.

The motivating shape (Project-c #143, task `444d53d5`) is a workerless external
review-entry task with a manually authored PR, dispatch and merge holds, zero
runs and no author-side evidence. Source advisory or static-fit evidence is not
native proof. Nucleus never invents a role credit by aliasing a reviewer, and it
never adopts the source author.

## Rule

A brief or handoff may name **one** author-side proof selector and its exact
input hashes in structured frontmatter:

```yaml
queue:
  proofExecution:
    selector: "effigy test unit -- test/proof.test.ts"   # the brief-named command
    inputs: ["sha256:<64 hex>"]                          # optional pinned inputs
```

This is the admission subject, in the same spirit as Spec 054: prose headings
acquire no authority, and a task without the field has no proof route at all.
The project owner activates it with the existing owner authority (project owner
thread, operator at the board, or a relayed operator note) through the `proof`
verb (`queue.task` action `proof`), which `task.next` lists or refuses.

Activation creates one ordinary Nucleus-created **`executor` run on the same
task**, in the task's own checkout, at the exact published head:

- The run receives the normal admission launch path (`PaseoAdapter.createRun`
  with the standard admission environment) and ordinary slot admission, lease
  and custody. It is a genuine Nucleus agent with its own authenticated callback
  credential and coordinator generation binding.
- It runs only the brief-named selector. The prompt binds the exact head, branch,
  PR number and input hashes, forbids source writes, commits, pushes, branch
  swaps, worktrees, installations, review publication, merges and dispatch, and
  requires a `proof_executed` result with `proofResult {status, selector,
  exitCode, evidence}`.
  The executor prompt deliberately carries neither the repository validation
  policy nor the worker heavy-validation/commit instruction: those belong to an
  author delivering a change, and they would contradict the source-immutability
  rule. It names no review publication, no push and no coverage suite beyond the
  one selector.
- It publishes no review, mints no approval, grants no source authorship, and
  cannot reach merge. The task returns to the phase it was activated from, and a
  distinct later independent reviewer still performs its own required review and
  proof.

For a proof-only qualification gated by release GO, Nucleus binds the exact release
question and answer to the executor run: question id and text, verbatim answer,
answerer, a planner relay's operator quote, the linked board decision id when
present, and question/answer timestamps. A direct board answer's quote carries
the verbatim answer with its answerer and timestamp. The prompt requires the
executor to write this literal evidence to a mode-0600 receipt file before
invoking the selector. Nucleus supplies recorded evidence only; the executor
cannot invent missing authorization.

The proof-only release GO question is an operator decision on the board; Nucleus
does not prompt the retained reviewer or another agent to relay it. While that
question is open the task waits on the operator, not the planner: the blocker
ladder neither consults nor escalates the GO-gate reviewer's blocked report, and
`task.next` and the control entry refuse `route`, `restart`, `move` and
`retry_effect`, because each would start or re-drive a run the GO has not
authorized. If an
answered GO cannot dispatch because a Nucleus run is busy or capacity is
temporarily unavailable, Nucleus retains the answer and retries when the task is
free. `task.next` exposes `proof` for that answered GO while the task is still
blocked. A retained reviewer turn is stopped only when its current turn is
positively tied to both a `northstar_ask` call and a stale reporting-run result;
Nucleus records the exact stop intent, does not blindly repeat an uncertain stop,
and settles it from a fresh observation.

### Allowance per exact head

Ordinary author-side proof has one execution per distinct exact source head. It
is spent at that head when the executor run is reserved; a lost creation reply,
a denial, a failed selector, an unreadable source or a cancelled run never
refunds it. A second call at the same head refuses. A new head qualifies only
after an authenticated author revision and an authenticated retained-reviewer
source approval both name that exact head. The reviewer's `ready_to_merge`
verdict at that exact head is source approval; an explicit `sourceApproved`
field is needed only for the blocked, proof-wait form. Proof admission still
requires the released reviewer run and its authenticated completion to agree
with the applied review at that head. Every earlier execution and receipt
remains append-only and unchanged. Tasks predating this spec read
`proofExecutions: []` and gain nothing implicitly.

A proof-only qualification has one execution allowance for the task. A report
without a selector result does not prove whether the selector started. Nucleus
records `selectorStart` as started only when the authenticated executor result,
its covered tool timeline, or a matching Effigy host-admission record supplies
positive evidence; otherwise it records unknown. A missing or inconclusive
observation never refunds the allowance. Legacy `refusedBeforeSelector` values
inferred from report shape are history, not proof of absence. A provider can
terminate a shell before a long selector finishes: the actual provider and tool
limits govern its runtime, and a partial run is never a pass. A Claude shell was
observed cut off at 30 minutes in effigy#666; no portable duration is established
for other providers. The selector timeout itself does not extend a provider shell.

### Amendment binding (Queue #407)

The brief's declaration and the task's operative `queue.proofExecution` are the
same subject, and the ordinary owner amendment binds them. `amend_brief`
([Spec 050](050-owner-task-controls.md)) parses the amended brief with the
task's normal schema and approval provenance, and in that **same versioned
write** sets the task's operative declaration from the accepted brief — before
any executor reservation exists. That includes a task whose previous brief
already declared it while the operative field was never set (the reported
Project-c #143 shape: a held workerless review-entry task, valid declaration in the
brief, no operative field, no run and nothing spent). No recreation, raw store
write or historical rewrite is needed: the owner amends the brief, then calls
`proof`.

Before a reservation, an amendment may also change the selector or inputs, or
remove the declaration, and the operative field follows the accepted brief
(`brief_proof_execution_changed` records each move). Nothing is spent, refunded
or transferred: there is no execution to spend yet, and a cleared declaration
just means the task names no proof until a later amendment names one again.

A reservation is the append-only `proofExecutions` record or the executor run
itself. An unknown start, lost creation reply, live run, failed or cancelled run
and historical execution all count. The selector becomes immutable as soon as
an attempt is recorded. No missing callback or inferred pre-selector refusal
releases that reservation. After a reservation, input hashes may be
re-declared only for a new exact head whose authenticated author revision and
retained-reviewer source approval are both recorded. That amendment pins a new
brief version and binds the new hashes for the next executor; the earlier run
and receipt retain their original hashes. At the same head, or without both
proofs of the new head, changed hashes are refused without a partial write.
Body-only amendments remain accepted. A reservation at one head does not spend
another head's allowance, but a second reservation at that same head always
refuses.

### Retirement after a spent selector (Queue #662)

Planner change for Tom to confirm: after a selector-started execution is
recorded, the owner may omit `queue.proofExecution` in an ordinary
`amend_brief` to retire that declaration. Retirement is accepted only when the
task has a spent selector-started receipt and every executor run is settled and
known. A live, unsettled or unknown executor run still refuses the amendment.
Nucleus records `brief_proof_execution_retired` with the amendment reason, marks
the declaration retired in task detail and `task.next`, and stops offering
`proof` as an available action.

Retirement is one-way: later amendments may omit the field, but naming the old
selector or any replacement selector is refused. Retirement changes no
`proofExecutions` record and does not satisfy any proof requirement or clear a
reviewer's `awaitingProofs`; those proofs still need separate evidence before
merge. Tasks whose selector has not started retain the existing amendment
rules, including the existing refusal after a pre-selector attempt.

### Single-flight launch (task 560)

Dispatch is single-flight: one executor per task and head, never two. The
executor run intent is recorded before the adapter call, and every dispatch
path — the owner `proof` activation, the proof-only promotion and advance
loop, and the in-review proof path — refuses a second dispatch while an
executor run for the task is unreleased, or while that head is already
recorded, before anything is sent. The refusal is re-checked inside the
reservation transaction that records the run, so concurrent triggers mint
exactly one executor and spend the allowance exactly once (Project-c #242: one
owner `restart` produced two executors 1.7 s apart because the restart path
and the advance loop each launched). The proof-only remote source proof (the
fetch plus its `FETCH_HEAD` read and ancestry check) runs in one critical
section per checkout, so concurrent verifications cannot fail each other with
a spurious source-moved refusal.

### Dispatch, stops and re-reports (nucleus#1195)

An executor dispatch is **proof execution, never a retry**. The automatic Spec
058 start (a retained reviewer's source approval whose awaited proof is the
brief's own selector) and the owner `proof` activation are the same proof
execution: the owner's `noAutomaticRetry` rule neither fences nor escalates
them, no `automatic_retry_suppressed` event is charged as `recovery_rerun`, and
no recovery episode opens while an executor run is unreleased. A running proof
execution owns the lane: its receipt is the next move, so the task is not
re-stamped as a stopped or needs-attention task while the executor still works.

An owner stop never interrupts a live executor. "Stop and keep the work" and
any other owner stop apply the dispatch hold and leave the executor's turn alone
until it reports or ends: the `owner_stopped` audit records the executor under
`executorContinues` instead of cancelling its turn, because the run is
source-immutable and may be mid-report. Its own result still enters ordinary
intake under the hold, and the hold keeps the next dispatch from starting.

A report lost in flight is re-requested, never re-run. When an executor run is
unreleased, its agent is idle and no result is recorded, `next` offers
`restart role=executor`: Nucleus freshly observes the executor and asks that same
executor, on its existing run and credential, to resend its report only. The
request is one bounded delivery per run (a durable intent before the send and its
outcome after it); it re-runs no selector, spends no allowance and starts no run.
`tell` also accepts `role: executor` for a live executor run, so an owner,
planner or the task's own agents can reach that thread for information. A resent
report enters ordinary intake, including the `proofFiles` copy.

### Source immutability

`verifyProofSource` proves, before activation and again before a passing result
is accepted:

- the task directory is its own Git root, on the task branch, at the exact
  published head;
- tracked source and the index equal that head (untracked build output is
  allowed, because a proof produces it);
- the remote branch head is the same exact head.

Activation refuses a moved local head, a moved remote branch, a dirty or staged
tree, or an unreadable checkout, and creates no dispatch and no allowance
record. A passing callback is refused after source drift: the role can never
claim passing source-immutable proof once source moved. A blocked or error
result remains recordable — conservative evidence is not a pass. A blocked or
error report without a selector result settles as unknown; the allowance stays
spent and a proof-only receipt goes to the retained reviewer for judgment.
When that receipt is settled and no closeout verdict is recorded, `move to=review`
and `route role=reviewer` start a fresh receipt reviewer at the same commit: the
receipt is the subject, so no PR is needed, and no executor or allowance is spent
again. `next` then marks `proof` unavailable because the one allowance is spent.
A proof-only escalation never offers a worker return; it offers that receipt
review instead.
When the proof was named by
a retained source-approved review, a passing result continues to that reviewer
at the same head in an evidence-only turn; otherwise it follows the ordinary
independent review path. The receipt itself grants no approval. Settlement clears or rewrites an old
`awaiting_proof` stop from the settled result. An owner may still use
`restart role=reviewer` with an instruction after an executor result, provided
the PR remains at the proof head, to ask that same reviewer to judge the receipt
manually.

### Evidence, not authorship

Each execution appends one immutable `proofExecutions` record naming the
executor run, agent, workspace, profile/model, operation, selector, input
hashes, repository/PR/branch/head, brief version and digest, the owner
authorisation and its result. The source-author declaration on the review entry
is never changed. Reviewer selection and `verifyReview` exclude the executor's
recorded models and agents in addition to the source author, so a later review
is independent of both without reminting the author.

An executor run that is superseded after it actually ran keeps its execution
record (task 560). When its agent's late report arrives, the reported status,
exit code and evidence are recorded as historical evidence on that run's own
record (`proof_execution_historical`) instead of rejected as stale, so the
record never stays `running` with no completion. When no report ever comes and
the run's own timeline proves the declared selector ran (a terminal shell tool
call whose command invokes the selector — the selector as the launched command
itself, unquoted and in command position, transparent launchers such as
`timeout 600` aside), the record
settles the same way with status `unknown` — it ran, and no result was ever
reported; an inconclusive, gap-ridden or partial timeline read settles nothing,
and neither does a mere textual mention: an `echo`, a comment, a quoted string,
a parameter or arithmetic expansion (an `echo ${selector}` expansion runs
nothing), or a fragment inside a larger word is never evidence it ran; command
substitutions and boundary brace groups genuinely execute their contents and
still count, and a command the
invocation rule cannot read is a miss that leaves the record to the report
path, never a guess.
A report arriving after a timeline-only settlement upgrades it with the
reported result, and a record settled from a report is final: later reports are
stale and never rewrite history. Historical evidence spends no allowance, is
never a pass, and moves no phase, current run, review, verdict or merge; the
run row itself keeps no completion, so no proof gate can read the history as a
passing claim. It carries `historical: true`, and proof-only closeout reads
that flag: a retained reviewer's ready_to_merge verdict resting on a
historical receipt alone closes the qualification failed, whatever the receipt
claims, and the reviewer's prompt says a historical receipt can never pass.

The durable qualification evidence starts with the overall result (`passed` or
`failed`) and labels the executor's status as the receipt status. A failed
review of a passing receipt therefore cannot read as an overall pass.

After a proof-only task closes, Nucleus archives its owned workspace at the
immutable qualification commit and archives its remaining Nucleus-owned task
threads. The ordinary terminal checks still require clean contents, published
source, no other task using the workspace, and idle agents without pending
permissions.

For multiple proof heads on one task, Nucleus continues the latest retained
executor thread when it is healthy and its model is unchanged. It creates a
replacement only after provider failure, an unrecoverable session, or a
different selected model, using the shared worker replacement decision. Once
replaced, a released executor thread is archived after no run still uses it;
the retained executor, worker and reviewer stay available. Every proof remains
a fresh assignment bound to its own run and exact head.

### Operator receipt acceptance (Tom, 2026-11-08)

A proof-only qualification can close failed on a finding that isn't about its
evidence. effigy#706's receipt passed, and the reviewer's only finding was a
worker profile preference that never binds the executor. Tom chose "Option A":
an operator-only route that accepts the recorded receipt as release evidence.
The operator may accept the latest settled, non-historical passing executor receipt
for a done, failed proof-only qualification when its run, commit, selector and
input pins match the failed result and declaration. The board offers the action;
an operator-relayed note can record the same authority. Planners, deciders,
reviewers and workers cannot grant it. Missing, superseded, failed, unknown,
unsettled or mismatched receipts refuse with their reason.

One transaction records the operator, time, reason and receipt identity, preserves
the failed result and reviewer verdict, and marks the qualification passed with
the receipt as release evidence. A repeat changes nothing. The task stays done;
no run, allowance, refund, new review verdict or other proof credit is created.
Task detail, activity and completion notice retain the original verdict beside
the acceptance.

## Holds, pause and activation

Activation is explicit owner authority; it releases nothing. A dispatch hold or
a pause refuses it, naming the ordinary exit (`release kind=dispatch`, or
unpause). A merge hold is never consulted or changed — proof execution has no
merge path. Dispatch, merge and pause state are preserved exactly; feature
delivery alone activates nothing and starts no allowance clock.

## Refusals

| Condition | Refusal |
| --- | --- |
| No `queue.proofExecution` on the task | The task names no author-side proof selector |
| Amendment after a reservation changes the selector or removes an unreadable declaration | The selector is immutable; a readable declaration may change input hashes only for a new head with recorded author revision and retained-reviewer source approval |
| The current exact head already has a proof reservation | That head's allowance is spent; inspect the recorded run; never repeated or refunded |
| A second dispatch while an executor run is unreleased, or while that head is already recorded | Single-flight: refuses before anything is sent; concurrent triggers mint one executor |
| Another run is live | The proof executor starts only on an idle task |
| Dispatch hold | The named hold blocks it; `release kind=dispatch` is the exit |
| Nucleus paused | The executor waits for unpause; no execution was activated |
| Phase is verifying/merging/closing/done/cancelled | Proof applies before independent review |
| Local head, remote branch, branch name or tracked bytes differ | Source drift/dirty refusal before any dispatch |
| No eligible profile or no slot | Dispatch waits visibly; activation reports it was not dispatched |
| Late/released/unauthenticated callback, except a superseded executor run's late report | Stale run; no receipt |
| Late report from a superseded executor run that actually ran | Historical evidence on its own execution record; spends no allowance, never a pass, moves nothing |
| Timeline-only evidence of a superseded run's selector | The record settles as historical `unknown`; an inconclusive read settles nothing |
| A late report against an already settled historical record | Stale; settled history is never rewritten (a timeline-only `unknown` is upgraded by a report) |
| Proof-only closeout over a historical receipt, even with a ready_to_merge verdict | Closes failed; historical evidence is never a pass |
| Passing result after source drift or with another selector/no `proofResult` | Refused at the receipt boundary |

## Contract deltas (same PR)

- `submissionSchema.proofExecution` and brief/handoff frontmatter
  `queue.proofExecution`; task field `proofExecutions` (default `[]`).
- `amend_brief` binds the accepted brief's `queue.proofExecution` to the task's
  operative declaration in its existing versioned write (`brief_proof_execution_changed`),
  and refuses an incompatible change or removal once an executor run or record
  exists. No new field, verb, role or receipt.
- `Run.role` gains `executor`; `Run.proofExecution` binds selector, inputs, PR,
  tree, brief, operation, return phase and the owner authorisation.
- Proof-only executor bindings also carry recorded release GO evidence;
  proof-execution records distinguish observed selector start from unknown.
- `completionBaseSchema` gains status `proof_executed` and `proofResult`; the
  proof result is accepted only on an executor run and only with its declared
  selector.
- `queue.task` action `proof` (durable external-effect operation),
  `task.next` verb `proof` with its refusal, and the MCP report schema gains
  `proof_executed`/`proofResult`.
- Prompt text for the executor and the author-side evidence block in reviewer
  prompts; `task.detail` already carries the full task, so the new field reaches
  the board without new UI markup.
- Task 560: `proofExecutions` records gain `historical` (default `false`), set
  on evidence recorded from a superseded run; closeout, and every pass gate,
  read it.
- No change to `queue.stages`, declared-stage execution (stays retired), review
  gates, merge gates, callback authentication, holds or deliverables. Old
  tasks, runs, receipts and outcomes parse unchanged and nothing is backfilled.

## Tests

`test/proof-execution.cases.ts`, run through the five shards `test/proof-execution-1..5.test.ts`, runs the public `queue.task` control, the durable
`task_control` operation and the real `QueueRuntime.taskControl` (RuntimeOwner)
route over a real disposable Git fixture in the review-entry shape: held +
workerless intake, direct-owner and relayed activation, genuine executor run at
the exact head, dispatch and merge holds preserved, drift, dirty source,
allowance exhaustion, wrong-selector and missing-result refusals, source
mutation before a passing claim, lost creation reply, the executor prompt's
immutability, the `task.next` view and the brief frontmatter. The source-proof falsification fails on the parent commit (no `proof`
action, no executor role) and fails when the source proof is removed.

The amendment binding (Queue #407) is proved through the same public routes over
the reported shape — a held workerless review-entry task whose brief frontmatter
names the proof while the operative field is absent: the public `amend_brief`
binds the exact selector and input hashes in one versioned write and preserves
source author, intake, PR, head, workspace, history and both holds with zero
execution; a mechanism-revert of that one write (the parent's behaviour) leaves
the declaration unbound and the `proof` verb refusing; pre-reservation change
and removal follow the accepted brief without minting credit; after a running,
uncertain (lost creation), failed and historical reservation, a changed or
removed declaration is refused with nothing written while an exact body-only
amendment still lands and a second activation stays refused; a stale version
fences a sequential amend/proof pair, and an amendment that lands while the
durable `task_control` proof operation is in flight is fenced inside the
reservation transaction, leaving one binding and one allowance at that head. A malformed
declaration and a merged task refuse through the existing parser and merge gate.
`test/proof-only.test.ts` proves the single-flight rule over a real disposable
Git fixture in the proof-only shape: two concurrent dispatch triggers mint
exactly one executor and spend the allowance exactly once, and a superseded
executor run's late report records failed evidence with its exit code as
historical evidence without spending, passing or moving anything. It also
proves the closeout and settlement rules: a historical passed report never
satisfies proof-only closeout (the retained reviewer's ready_to_merge closes
the qualification failed and settled history refuses later reports as stale),
and timeline-only evidence settles a still-running record as historical
`unknown` only on a complete, terminal read of a command that invokes the
selector — a textual mention (echo, quoted string, comment, parameter or
arithmetic expansion) settles nothing —
while a gap or a running call
settles nothing and a later report upgrades the settlement with the reported
result.

## Unproven branches (honest gaps)

- The engine fixture's adapter boundary is `createRun`; the admission
  environment itself is attached by `PaseoAdapter.createRun`
  (`mergeAdmissionLaunchEnv`) and is not re-proved here. No live consumer task
  was touched.
- No installed-bundle UI validation: no UI markup changed and the board reads
  the new field from the task detail payload.
- `stale`/`unknown` record states are produced by the defensive settlement path
  when a completion survives outside the normal receipt boundary; the primary
  route refuses the passing claim instead of downgrading it.
- The executor runs in the task checkout (a review-entry workspace or a clean
  worker checkout). A workspace whose head lags the pinned published head
  refuses activation; Nucleus does not create a disposable checkout for it.
- An executor creation whose reply is lost stays `uncertain` with its allowance
  spent and never re-dispatches. `restart` clears that unresolved run through
  the existing absent-resolution path (admitting no second proof); the
  follow-on launch of a replacement executor is not exercised by a test, and
  the supported owner exits there are `move to=review`, `complete` or `cancel`.
