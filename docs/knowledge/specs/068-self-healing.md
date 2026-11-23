# Spec 068 — Self-healing

Status: approved (Tom, 2026-11-22: "Sounds good, let's do it", accepting the design and the planner's recommended answers under [Decisions](#decisions)). Batches briefed.
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
`{state, role, since, detail, lastActivityAt, tool?, attempt?}`. The reconciler,
`next`, the board and the ACP task thread all read it, so what is shown is what
Nucleus acts on. Its inputs are facts, not host display:

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
the fallback is one replaced status line.

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
  blocker ladder. A refused move, a result application that changes nothing, or
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
  No host declares the capability today.
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
| 5a | nucleus#1553 | Budget policy and outage time, typed budget and cap stops, round-3 automatic continue, and the coordinator cap counting failures. | 1 |
| 5b | nucleus#1556 (cancelled; built as a direct PR) | Hung-tool limit, permission policy and orphan-phase readmission. Done. | 1, 3b |
| 6 | nucleus#1557 | Reads leave the task lane. | nucleus#1545 |

**Done when:** over one week, no task spends more than 30 minutes outside the four
states, and no planner or operator action resolves a mechanical stall.

## Decisions

Tom accepted the planner's recommendations on 2026-11-22 ("Sounds good, let's
do it"):

1. **Budgets.** Time while a host or the service is down never counts; today
   only host outages pause the clock. When a budget is spent, Nucleus extends it
   automatically once, with an event. The second time, it asks through the Inbox.
2. **Round-3 question.** Nucleus continues automatically up to the revision cap
   and tells the task's planner. The cap itself stays a question.
3. **Hung tools.** A command with no output for 30 minutes is terminated. The
   limit is a repository setting.
4. **Permission prompts in task runs.** Denied automatically, with a message
   telling the agent to work around it. An event is recorded, and recurring
   prompts show in the weekly repair line.
