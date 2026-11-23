# Spec 068 — Self-healing

Status: approved (Tom, 2026-11-22: "Sounds good, let's do it", accepting the design and the planner's recommended answers under [Decisions](#decisions)). Batches briefed. Batches 3a and 3b are built directly with subagents as batch A (Tom, 2026-11-23: "These are the sorts of issues that I need nucleus to be able to self-heal without needing you to triage like this" and "Yes, I'd like you to go ahead and fill the gaps using subagents"); see [Batch A](#batch-a-dead-agents-and-uncertain-launches).
Builds on [Spec 066](066-one-reconciler.md) and [Spec 067](067-explicit-resolution.md).
Audience: queue implementers, reviewers, planners and coordinators

## Outcome

Tom, 2026-11-22: "We need nucleus to be self healing - ideally I shouldn't need
to have to ask you to scan the board and unstick tasks.. I want it to be able to
recover autonomously; we'll need to identify the states that require recovery
and work out how to consistently resolve them without intervention." And: "it's
worth putting some more work into the ACP adapter so that it's clear when a
thread is _actually_ working / reviewing and when it's in the in-between states,
stuck etc, and make the output clearer too."

Spec 067 made every mechanical state resolvable in one explicit command. This
spec makes Nucleus run those commands itself. A person acts only on a question
about the work. Everything Nucleus believes about a task is shown truthfully in
the task's thread.

## Evidence

The planner read a copy of the 2026-11-22 14:14 backup covering 15–22 November.
It also traced each of the ten stuck states the planner cleared by hand that day
to the code that gave up on them.

- Planners or the operator resolved 600 stuck episodes on 329 tasks, adding up to
  500 stuck hours. Planner agents took 584 of them and the operator 3. The
  reconciler resolved another 2,693 on its own.
- Most of the stuck time was mechanical:

  | Class | Episodes | Hours | How it was resolved |
  |---|---|---|---|
  | Uncertain worker, reviewer or revision creation | 22 | 56 | `retry_effect`, `restart`, `run.start fresh` |
  | Host could not read the thread's state | 24 | 48 | `restart role=worker`, `complete` |
  | Run stalled, or its process was gone | 6 | 17 | `run.release`, `restart role=reviewer` |
  | Ordinary review refused before send | 38 | 17 | `move to=review` |
  | Verdict reported but never applied | 3 (on 22 Nov) | 3 | `move to=work` with the findings |
  | Detached task checkout blocks reviewer creation | 3 (on 22 Nov) | 1 | branch reattached by hand |

- Judgement escalations were frequent but fast: 166 episodes of a worker reporting
  blocked, with a median answer under a minute. These stay with planners.
- Policy stops were answered the same way almost every time:
  - Budget extended 34 times out of 35.
  - "Continue the current approach" chosen 48 times out of 50 at the round-3
    question.
  - Revision cap re-armed with `move to=work` 15 times out of 18.

The evidence and scripts are kept outside the repository.

## Root causes

1. **Absence is never proof.** A thread missing from a complete host read
   neither settles an uncertain creation nor releases a finished run.
2. **Display beats facts.** Liveness comes from the host's displayed status.
   A dead process reported "running" blocks stall exits and coordinator launch.
   A hung tool stops stall detection entirely.
3. **Results wait on threads.** A verdict applies only after its run is
   released. Release needs a live host read, and release deletes the run's
   ticket, so a late report is refused.
4. **The repairer is blocked by the fault.** A coordinator needs a recorded
   stop, idle participants and no host-read hold. Its prompt forbids creating
   agents and resending. The launch cap charges successful repairs.
5. **Gaps between commands.** No command reattaches a detached checkout. A
   non-terminal phase with no run and no stop has no owner and reads
   "progressing".
6. **Expensive reads run in the task's lane.** Process tables, timelines and
   paired T3 inventories push task quanta past 120 s and cause churn errors.

## Design

### 1. Four states, never a fifth

Every non-terminal task is always in exactly one of these:

| State | Meaning | Shown as |
|---|---|---|
| **Active** | A participant is demonstrably working: a turn in progress with recent activity, or a tool running inside its limit. | "Reviewer · running `effigy test` · 3 min" |
| **Nucleus's move** | Nucleus waits on a named fact (a slot, integration turn, checks or host) and has an observation deadline. | "Waiting for a review slot · 2 ahead" |
| **Recovering** | An automatic repair is in flight, with its cause and attempt count. | "Reviewer thread vanished · starting a fresh reviewer (1 of 3)" |
| **Needs a person** | A question about the work, raised through the planner ladder and the Inbox, with its explicit commands. | "Needs you · worker blocked on scope" |

Any other state is a defect. Each sweep classifies such a task and moves it into
one of the four. It is never left in place.

### 2. One activity reading (the ACP work)

`shared/` gets one derivation, `taskActivity(facts)`, which returns
`{state, role, since, occurrence, detail, lastActivityAt, tool?, attempt?}`. The
reconciler, `next`, the board and the ACP task thread all read it, so what is shown
is what Nucleus acts on. `occurrence` names the fact that owns the current reading —
the decision, stop, host wait, permission, deferred coordinator host read, repair
episode or last concluded run —
and stays the same while that fact holds, so a reader can tell one wait from the
next without reading the task's write timestamps. Its inputs are facts, not host
display:

- **Process facts.** The participant's recorded process and start identity are
  alive or gone. A process older than the last boot is gone.
- **The participant's activity stream** from the host timeline:
  - the latest event and its time;
  - the running tool, with its start and last output;
  - a pending permission request;
  - the turn's stop reason.
- **Nucleus's own stops, waits and repair records.**

The task's ACP thread shows that reading, using the native structures of ACP
instead of a stream of text lines:

- **Plan.** The lifecycle is a `plan` update (Queued, Working, Review round N,
  Merge, Close), with each entry pending, in progress or completed.
- **Tool calls.** Each participant run and each automatic repair is a
  `tool_call` with a plain title, such as "Reviewer: reading the diff" or "Fresh
  reviewer after the thread vanished". `tool_call_update` keeps its status and
  elapsed time current.
- **Messages.** These are only for things a person reads: a verdict summary, a
  question, the finish.

T3's ACP client carries the `plan`, `tool_call` and `tool_call_update` shapes.
The planner checks how they render after batch 2 rolls. If either renders badly,
the fallback is the deduplicated append-only status line: one line per real status
change and nothing on a tick that changed nothing (planner ruling, 2026-11-23 —
ACP `agent_message_chunk` is append-only, so a line is never replaced).

### 3. Facts that settle things

These close root causes 1–3:

- **Creation lookup, for every role.** When a launch is uncertain, the sweep
  looks the run up by its label (this generalises the coordinator's existing
  `creationLookup`):
  - one match binds it;
  - no match on a complete read after the grace period releases the run, and
    ordinary admission relaunches it;
  - a partial read keeps waiting.

  A single-thread lookup reads the live list and then the archived list, with no
  sequence pairing. On T3 this is now the live shell plus one exact read by id,
  with no archived list at all ([Spec 069](069-scheduler.md) batch 5; Tom,
  2026-11-22: "We shouldn't need to be reading archived threads at all").
  nucleus#1555 builds on that lookup (`T3Reads.readThreadRecord`) rather than
  adding an archived-list read.
- **Process death releases a run.** Positive proof that the recorded process is
  gone releases a stalled run. An unreadable process table proves nothing.
- **A completion releases its run.** Once a run has an authenticated completion,
  it is released when its thread is idle, archived, gone or unobservable past a
  bound. The verdict is applied under its own checks. A released reviewer keeps a
  ticket that is good for verdicts only, so an exact-head report still lands.

### 4. Repairs are code

The sweep applies the Spec 067 plans itself (`runStartPlan`, `releasePlan`, the
verdict application, a reattach step) whenever a fact from §3 makes the step
safe. The LLM coordinator is kept for ambiguity, and planners for judgement.

- **Reattach.** Before a launch, and in `run.start` and `run.release`: when no
  unreleased detached run owns the checkout, the tree is clean and HEAD equals the
  branch tip, check out the branch. The commit never moves; every other state is
  left alone with the reason reported. A follow-up review round reads its exact
  head in the shared checkout on the attached task branch, so no round leaves the
  checkout detached (planner ruling, 2026-11-22: a per-round worktree would break
  Spec 057's task-workspace identity and start without `node_modules`). When the
  branch tip is not the reviewed head it refuses by name and never detaches.
- **Orphan phase.** A non-terminal phase with no live run and no stop returns to
  ordinary admission for its role, or records a typed stop. Built (batch 5b): a
  `working`, `changes_requested`, `awaiting_review` or `reviewing` task whose
  activity reads `unclassified` with no participant for five unchanged minutes
  goes through the owner's own `move to=work` or `move to=review`. States other
  owners hold are never orphans, including an armed worker replacement or
  failover, a provider retry and a blocking side effect. A released revision
  whose authenticated report nothing applied goes back through ordinary result
  application, so a pushed head goes to review and a blocked report climbs the
  blocker ladder. So does an initial worker's report whose binding was released
  before it applied: it gets its run binding back and the worker's own result
  acceptance verifies the PR it names at the exact head. A lifecycle wait does
  not hold that result, since nothing else owns it, and neither does a recovery
  episode that escalated over that wait; an open planner escalation still does.
  A resolved recovery episode is history, not an owner, and an intent flag holds the task only while its
  creation has bound nothing. A refused move, a result application that changes nothing, or
  a fourth readmission in one episode with nothing started records
  `operator_needed` with fact `orphan_phase`. The readmission is the backstop: a
  state that reaches it is some owner deferring silently, and the cause is fixed
  in that owner. bovine-accelerator#6935's was result application's participant
  lease. While the worker's thread stayed in its turn after reporting, the lease
  declined without a word; it now records the same visible wait every launch's
  lease decline does.
- **Hung tool.** Past the tool limit with no output, Nucleus terminates that
  command's own process. It identifies the process by PID and start identity, and
  never kills the turn. The agent sees a failed tool call and continues. Built
  (batch 5b): the command is the topmost process under the run's provider whose
  command line carries the tool's command; its own group, else its own pids, get
  SIGTERM then SIGKILL, each after a fresh start-identity read. A command that
  cannot be stopped no longer fences stall detection. Silence is known only when
  the host showed that call's output at least once, or declares
  `streamsRunningToolOutput`. Many providers return shell output only when the
  command ends, so a call with no output shown is unknown and never terminated.
  No host declares the capability today. Follow-up, not in batch 5b: the quiet
  clock depends on `lastOutputAt` advancing with every output chunk, and only
  T3's explicit `lastOutputAt` is tested. Verify BB's timeline shape (and any
  other host's) before it relies on this.
- **Interrupted tool.** A call the host reports `interrupted` with its turn
  (bovine#6928: T3's "Stopped by user") is finished once the turn is proven
  over. A kind that can outlive its turn, such as a shell command, still takes the
  owned-process proof, so a background child that survived the interrupt holds.
  Built in batch 5b.
- **Permission prompt.** A pending permission request in a task run follows the
  policy under [Decisions](#decisions). Built (batch 5b) for worker, revision
  and reviewer runs on T3, BB and Paseo, which all answer permissions natively
  (Paseo gained the answer, with its message, in this batch). A decline with an
  unknown outcome is never resent, and a request still listed after it goes to
  ordinary stall detection. Coordinator runs are outside the stall observer and
  keep their profile's mode.
- **Coordinator cap.** The cap charges only repairs that applied nothing. A
  hard ceiling of six coordinator launches per head remains.

### 5. Bounded and visible

- Every automatic repair records an event, shows as **Recovering** and has a
  per-cause attempt bound (default 3).
- Past the bound, the task becomes **Needs a person**. The stop carries its
  explicit command and reaches the Inbox.
- A spent budget or cap is a typed stop worded as such, never "progressing".
- The board header gains no counter. Instead, a weekly line in Settings shows how
  many repairs Nucleus made and how many needed a person, by class.

### 6. Reads leave the lane

Process-table and timeline reads move into the host pass, with one snapshot per
pass. Every read inside a task quantum gets a deadline and returns "unknown" when
it misses (Spec 066 R1). This shares its approach with nucleus#1545 (async
segregation) and Spec 067 batch 5 (host health).

A pass snapshot clears an owned-tool hold only when the host pass observed the
participant inactive before it captured the process table. A participant outside
the pass inventory (the task-row worker, a released reviewer) had no such
observation, and the warm cap could skip its tool page, so merges alternated
between those two waits forever. A quantum that reads a participant's page or
process snapshot now registers a demand, keyed by host and participant. The next
host pass observes every demanded participant, and the rest of its task's
participants, before its process snapshot, then warms their pages first, outside
the warm cap but inside the pass budget. A demand that no quantum renews expires
after one pass. The proof converges in two passes, and a snapshot taken before
any inactivity proof still never clears a lease.

An ordinary review send that hits an unknown proof releases its unsent run and
waits with a `pass_proof` fact. The next host pass serves its custody participants,
including retired workers with explicitly released runs, under the same
freshness rule. The send keeps its normal review instructions and any named
checks. Custody checks freshness before using a cached process or tool
observation to clear or hold custody. Evidence from before the participant's
latest activity and transient custody read failures both leave the proof
pending and renew the demand. If a completed host pass still cannot
serve the proof after five minutes of host and service uptime, the task stops with
`pass_proof_exhausted` and names the unread proof.
The bound starts at the first proof wait for that review round and head, even
when an intervening host read writes a different visible wait.

A planner's owned-tool `retry_effect` or `move to=review` waits through the
bounded host-read retry. Each retry uses a completed pass on the task's host
while its snapshot is active. The pass also serves recovery and closeout
participants named by an owned-tool retry. Proof retries have their own batch
and run while paused so an accepted read-only proof can drain. The verb
records its outcome when it settles. A coordinator's accepted action stays
pending on an unread proof.

Reusing a previous pass's snapshot was rejected: it would carry reads across
passes, and that snapshot predates the participant's observation too.

## Safety

These rules stay:

- **One writer.** A worker is released only on proof of death or an
  authenticated completion. Absence on a partial read never counts.
- **Exact-head review** and the merge gates.
- **Unknown delivery is settled, never resent blindly.** It is settled by
  lookup. The rule that kept it waiting for a person goes, not the rule against
  resending.
- **No narrow fixes.** Every repair is one general rule over facts. Nothing here
  adds a guard for a single stuck state (AGENTS.md, Tom 2026-10-14).

## What changes in earlier specs

- **Spec 067:** the coordinator and the sweep both apply explicit commands. The
  recovery prompt's "do not create agents" rule gives way to creation lookup.
- **Spec 066 R3:** gains the four-state rule and orphan-phase readmission.
- **Spec 065:** the task thread renders the activity reading through `plan` and
  `tool_call`.

## Batches

Each batch is at most 3 modules and about 1.5k lines, so batches 3, 4 and 5 are split in two.

| Batch | Task | Scope | Depends on |
|---|---|---|---|
| 1 | nucleus#1549 | `taskActivity` and its facts (process liveness, running tool, pending permission, last activity). The board and `next` read it. No behaviour change. | — |
| 2 | nucleus#1554 | ACP task thread: `plan` progress and `tool_call` runs and repairs, plus clearer messages. | 1 |
| 3a | nucleus#1555 | Creation lookup for every role, and single-thread T3 lookup. | 1, Spec 067 batch 5 (nucleus#1523) |
| 3b | nucleus#1552 | Process-death release, and `run_stalled` admits the coordinator. | 1 |
| 4a | nucleus#1551 | A completion releases its run, `run.release` keeps a reported verdict, and the verdict-only credential. | — |
| 4b | nucleus#1550 | Branch-attached follow-up review reads, and one reattach step for detached task checkouts. | — |
| 5a | direct PR (nucleus#1553 cancelled) | Budget policy and outage time, typed budget and cap stops, round-3 automatic continue, and the coordinator cap counting failures. Built: see [Batch 5a as built](#batch-5a-as-built). | 1 |
| 5b | nucleus#1556 (cancelled; built as a direct PR) | Hung-tool limit, permission policy and orphan-phase readmission. Done. | 1, 3b |
| 6 | nucleus#1557 | Reads leave the task lane. | nucleus#1545 |

### Batch A: dead agents and uncertain launches

Built directly on 2026-11-23, replacing nucleus#1555 (cancelled) and nucleus#1552
(held; its process-death release, PR #453, is ported here). It covers 3a and 3b
and the gaps the 2026-11-22 T3 crash and reboot showed:

- **Dead agents release by themselves.** Process facts or a thread gone on a
  complete host read (the T3 live shell inside its bound plus an exact read by
  id) release a reviewer or revision run through `releasePlan`; ordinary
  admission relaunches it. A live recorded process vetoes thread absence. A host
  answer that a thread is gone is no longer swallowed as a host fault. A
  coordinator run the pass cannot observe takes the same proof: on proof its run
  is released, its episode closes (with any escalation it raised over the
  underlying fault) and its binding clears, so the stop admits a fresh
  coordinator under the coordinator cap. A failed or partial read and an
  archived thread prove nothing, and the episode keeps its ordinary handling.
  Another host fault or a transport failure is a recorded wait
  (`coordinator_observation_deferred`, read as Nucleus's move) bounded at five
  minutes unobserved while the host reads as up (outages and downtime excluded);
  past that the episode escalates, and a host that is down keeps its own outage
  wait. Three such releases
  per head, as for every role; past that the task records a typed stop naming
  `run.start coordinator fresh`.
- **A dead retained worker means a fresh worker.** The revision launch retires a
  retained worker whose thread is gone and continues the same revision on a fresh
  one; a dead initial worker with a PR continues it the same way. `next` offers
  `run.start worker fresh`.
- **Uncertain creation settles by lookup for every role.** A create that may
  still answer (a late reply on a live connection, for at most ten minutes)
  keeps the run waiting on its own cause, with no replacement offered and no
  coordinator admitted. The initial worker's create records the same wait as a
  run's, never a person's stop; a
  complete absent read after that relaunches the same run under the same host
  command id, which T3 resends only after reading the derived child absent, so a
  received create never becomes a second thread. Three relaunches per role and
  head, the host-read hold no longer keeping the coordinator out, and T3's lookup
  reading only the create commands its ledger recorded as sent.
- **Uncertain workspace creation settles the same way.** A dispatch that
  recorded its workspace intent and bound nothing, with no worker, run or PR
  identity, is looked up on its host. That is a first dispatch, or a re-dispatch
  after a host move that left no PR; a task with a PR identity keeps its
  continuation path. The lookup reads the host's workspace inventory, the
  expected worktree directory, `git worktree list`, the task branch locally,
  then on remotes when it is absent locally, and any Barge lease. One match
  binds it. A complete read proving none of it exists, once this service has no
  dispatch in flight for the task and the grace period since the last attempt
  has passed, releases the intent so ordinary dispatch creates it again; a
  Barge allocation intent is kept, so the same request replays. Nucleus's own
  residue, a task branch with no commits past the base, never pushed, with no
  worktree and checked out nowhere (papercut 703c357a), is removed at its
  inspected head before the release, and never by a quantum past its deadline;
  a branch with commits or a pushed ref is never touched. A partial or failed
  read (a branch or remote that could not be read is unknown, never absence),
  or a create still running, waits with its reason (fact `workspace_lookup`),
  read as Nucleus's move. A leftover with a worktree directory, or conflicting
  evidence, goes to a person with the verb its refusal names. Three automatic
  releases per task, counted since the last explicit one; past that a typed
  stop names `record.clear kind=workspace_intent` (Spec 067), and a transient
  read failure never replaces that stop. The command releases the intent
  without a proof after its `workspace_may_exist` warning (`effect_may_land` too
  while a dispatch is in flight). It clears only the lookup's own stop or a
  lifecycle wait, and refuses, naming it, any other owner's stop (a hold, an
  escalation, a budget or host wait). `next` offers it only while the lookup
  holds the task (its wait, its typed stop or the legacy generic wait) and no
  dispatch is in flight, so an ordinary populate offers nothing. A 2026-11-23
  task cycled on the old generic wait until a cancel and resubmit.
- **`run_stalled` admits its coordinator**, and a stop naming a released run
  clears.
- **A reported verdict is never dropped or stranded.** `run.start` warns
  `discard_reported_verdict` before replacing a reviewer whose exact-head verdict
  is unapplied, and a reviewer whose turn keeps running after its report has that
  turn stopped once so the verdict applies.

One gap stays open: escalation menus are not yet derived from the decision
`next` uses; the states above simply no longer escalate.

**Done when:** over one week, no task spends more than 30 minutes outside the four
states, and no planner or operator action resolves a mechanical stall.

### Batch 5a as built

Built as a direct PR (Tom, 2026-11-23: "fill the gaps using subagents"):

- **Outage time.** Every budget read discounts the task host's outages and the
  service's own downtime (`budgetOutageIntervals`). The running service stamps
  itself alive each minute and at the start of a drain; the next start closes the
  window from that stamp into the history (`serviceDowntimeHistory`). Each beat
  also records sleep: wall time past monotonic time since the last beat, when over
  a minute. An event-loop stall advances both clocks and records nothing. The
  history keeps 30 days of entries. The macOS sleep behaviour still needs one
  real sleep check after the roll.
- **Automatic extension.** The first spend of either limit is extended once by
  one default increment, by the launch gate or the sweep's settle pass, recorded
  as `budget_extended` with the detail `automatic: <policy>; <figures>`. The sweep
  extends only in a phase whose next step is a run, so a task verifying or merging
  keeps its extension for the launch gate. A task extended before (by any source)
  asks its planner on its next spend (delegated; no Inbox, see Decision 1). Until then, a first spend is no stop: `next`, the
  activity reading and the `run.start` warning ignore it.
- **Typed stops.** The settle pass records the `budget` stop for a spent task
  with no live run and no other stop whose next step is a run, and its question
  follows; a task verifying or merging is stopped only if that stage needs a run. `next` and the
  activity reading type a spent budget or an exhausted revision allowance as a
  stop for a person, and `next` lists `run.start … accept ["budget"]` (for a spent
  budget, only in a phase whose next step is a run). Only the planner or the
  operator board may accept `budget`; a coordinator is refused, and its snapshot
  leaves out any command whose preset accept or expected warnings name a
  planner-only warning. The revision launch gate, the
  `run.start` `budget` warning, the author-round rule and the activity reading
  share one cap condition (`revisionAllowanceExhausted`: a cap park with no author
  round, and no accepted round, since).
- **Revision cap at the launch.** A revision launch holds while the allowance is
  exhausted, however the task reached `changes_requested` (planner ruling,
  2026-11-23: `phase.set` passed the cap). The hold goes straight to the planner
  ladder, as the cap park does: it joins the cap's open escalation, or opens a new
  occurrence when the last was settled without a round. Its `escalated` stop is a
  waiting stop, so no coordinator is launched for it. The planner's or operator's
  `run.start` for the worker accepting `budget` creates the round's run itself. An
  author-round control (`move to=work`, `restart role=worker`, `route
  role=worker`, or a forced `move to=work` by the operator board or a live
  planner) by an authorized caller records `revision_cap_accepted` inside its own
  transaction, so only a control that applies grants the round (planner ruling,
  2026-11-23); a coordinator's is refused, and a participant's self-force records
  nothing. The cap park stays the stop and the planner escalation.
- **Round 3.** The third non-converging round records `review_round_continued`
  and tells the task's planner with the reviewer's findings; it asks nothing. A
  tell that sent nothing (the service stopped before its intent, or no planner or
  host was there) is sent by a later pass, a missed one at most every five
  minutes. A tell with a recorded intent is never sent again.
- **Coordinator cap.** A coordinator run whose owner verb or state-changing
  explicit command applied is not charged and ends the charged chain
  (`message.send` does not count); three runs in a row that
  applied nothing, or six launches at one head, stop the loop.
- **Explicit command output.** The CLI prints the outcome first and exits 2
  unless the command applied, and names the warnings only a planner or the
  operator board may accept. `next` lists each command's expected warnings.

### Acceptance

`test/spec068-crash-acceptance.test.ts` crashes one board of 17 tasks in one
step: the service stops mid-pass, every thread vanishes or goes stale, the T3
connection drops and some creates have unknown delivery. A new service owner
then runs the real Engine over the real T3 client on the fake Nightly, on a
shifted clock, with no owner, planner or operator command. It checks one thread
per run, one live run per role and head, exact-head verdicts and merges, no
resend without a complete absent read, the orphan bound, and budgets that skip
the downtime.

All seventeen tasks recover, and the file has no `todo` left. The four gaps the
first run found are closed:

- **A dead coordinator is a dead participant.** A recovery episode whose
  coordinator thread is gone releases the run on batch A's proof and admits a
  fresh coordinator, instead of escalating to the planner
  (`core/recovery/coordinator-pass.ts`; see batch A above).
- **An unknown first-dispatch create is Nucleus's wait.** The worker launcher
  records the same creation wait a run launch records (`creation_in_flight`
  while the host may still answer, else the creation lookup), never an
  `operator_needed` stop (`core/dispatch/worker-launcher.ts`).
- **One budget gate for every start.** Run launches and every worker creation (a
  first dispatch, a dead initial worker's redispatch, a resumed dispatch and a
  failover) pass the same gate: the first spend is extended once, and a later
  spend records the typed `budget` stop and starts nothing. The worker launcher
  reads it after its own drain, hold and catalog refusals, so a held or draining
  task keeps its own reason and is neither extended nor asked about. A task that
  never ran reads nothing used, so the gate holds only a task with a recorded run.
- **Stall windows skip downtime.** A wait's age is measured as budgets measure
  time: the wall span less the task host's outages and the service's own downtime
  (`waitAgeMs`). The coordinator route reads every stall window through it: the
  mechanical stall window, the idle grace after a coordinator's reporting
  reminder, the automatic reconciliation window and the repository contention
  grace, and the callback reminder's own grace reads it too. After a restart an
  ordinary wait (checks pending, say) admits no coordinator, and a reminder sent
  just before a roll does not escalate.

## Decisions

Tom accepted the planner's recommendations on 2026-11-22 ("Sounds good, let's
do it"):

1. **Budgets.** Time while a host or the service is down never counts; today
   only host outages pause the clock. When a budget is spent, Nucleus extends it
   automatically once, with an event. The second time, it asks the task's
   planner, which decides; it never needs the operator. Tom, 2026-11-23: "I always
   end up granting more budget - I don't need it coming to me, it can be
   automated. Just having the check is enough for the planner to consider
   whether a task is overdue." The budget stop stays as that check.
2. **Round-3 question.** Nucleus continues automatically up to the revision cap
   and tells the task's planner. The cap itself stays a question.
3. **Hung tools.** A command with no output for 30 minutes is terminated. The
   limit is a repository setting.
4. **Permission prompts in task runs.** Denied automatically, with a message
   telling the agent to work around it. An event is recorded, and recurring
   prompts show in the weekly repair line.
