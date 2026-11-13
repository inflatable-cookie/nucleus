# 016 — Live evidence before a recovery decision

Status: implemented
Owner: Nucleus runtime and recovery maintainers
Created: 2026-09-17
Governing refs: `docs/knowledge/contracts/orchestration.md`,
`docs/knowledge/specs/013-standalone-queue-service.md`

## Problem

The identity-and-recovery path repeatedly decided from a durable projection
while the authoritative fact was live, cheap to fetch and stale *because of the
very fault being handled*. Three incidents share that shape:

- A cancelled Project-a task kept a pre-cancellation attention flag, so
  `deliverNotices` kept routing it into recovery and **spent a real coordinator
  run on work the operator had already disposed of**.
- A worker whose reporting binding named another run could not report the PR it
  had opened, so recovery read "no PR in the record" and escalated a lane that
  was recoverable the whole time (`g03.260` #1066, `g03.262` #1069).
- The same lane reached a third fault: the branch-PR reconciliation that would
  have repaired it was gated behind an idle grace whose enabling stamp was
  written *below* the branch that returned, so the gate could never open.

Each was individually repaired. The value of stating the rule is to stop the
fourth, because each repair was local and none of them constrain the next path
that decides from a projection.

## The rule

**A decision that escalates, spends a coordinator, or returns work to a worker
must verify live any fact that satisfies all three of:**

1. the fact is authoritative outside Nucleus (a provider, a live thread, a
   checkout), so Nucleus's copy is a projection rather than the truth;
2. it is cheap to fetch relative to the decision it gates; and
3. its staleness is *caused by* the fault being handled, so the projection is
   least trustworthy exactly when the decision is hardest.

All three must hold. Condition 3 is what keeps the rule narrow: it does not
require a live fetch before every escalation, only before one whose own fault
can have hidden the evidence. A waiter or an observation that fails for an
unrelated reason still escalates from what Nucleus knows.

## Where it binds

- **Before escalating a fault as unrecoverable.** A confirmed absence may only
  be claimed from live evidence, never from an absent projection.
- **Before spending a coordinator run.** A recovery run is the most expensive
  thing the queue does on a lane's behalf; it is not the first probe.
- **Before returning work to a retained worker.** The return is gated on identity
  the queue must hold, so identity is established first.

The implemented instance is the queue-owned branch PR: it is read from the
provider before a split reporting binding is treated as unrecoverable, and
adoption re-issues the retained binding through the existing revision path.

## Rule 2: an empty fetch is not permanent absence

Any instrument that decides from live evidence defines a **bounded re-attempt**
rather than retiring itself on one empty result. A single empty or null answer
is evidence for one moment.

The branch-PR lookup retired itself permanently on its first empty result, so a
worker that opened its PR a minute later could no longer be repaired without an
operator. It now re-attempts with a backoff stepped in idle-grace multiples
(1, 2, 5, 15, then 60 minutes at the production grace), resetting on any new
worker activity, and records its event pair only when the outcome changes — an
unchanged empty result is kept as an attempt counter and last-checked stamp on
the task, not as a fresh pair of events per pass. An activity reset restarts
the schedule but keeps the outcome, so an unchanged result is not logged twice.
The general form is the rule;
that lookup is only its first instance.

## Rule 3: a completed disposition is terminal for the projection

Once a disposition completes, the task is disposed. Nothing later may derive
fresh work, a notice or a recovery from it.

- The terminal transition clears the attention episode the disposition answered
  and settles pending or in-flight notice intents, because leaving them live is
  what kept the disposed task eligible for later work.
- Resolution-run observation, notice delivery and recovery routing skip a task
  whose disposition is complete, so a later pass cannot re-enter recovery or
  derive a replacement run for decided work.

This is the member that wasted real resource. g01.034 implements the terminal
transition and routing guards.

## Rule 4: the live facts, closed and bounded

The rule names a shape; this closes it to a list, because an open licence to fetch
is neither affordable nor auditable. Each fact is bound to the decision point
that needs it.

| Decision point | Fact verified live | Status |
| --- | --- | --- |
| Escalating a fault whose own evidence it conceals | Open PR on the queue-owned branch | implemented |
| Escalating a reporting-identity mismatch | The retained worker's current binding and stopped state | **gap** |
| Declaring a missing callback, or refusing recovery resume of a stopped revision | Live `effigy qa` or repository QA process in the task worktree (complete scan; an incomplete listing is `unverified`, never absence), and the agent's own latest running non-turn-bound tool call on its provider timeline (unreadable or inconclusive evidence is never liveness) | implemented |
| Creating a coordinator or reviewer run | Exact identity of any existing run | already an exact lookup |
| Failover after provider exhaustion | The assigned agent's own observed provider error, or the current reviewer's own identity-bound terminal refusal in its dispatch turn | implemented |
| Transient provider failure | The retained thread's observed error and its run identity | resumes in place, bounded |
| Merge, sync or integration write | PR head/base, checkout cleanliness, manifest at the pinned base | already live |
| Owner-verb settlement of a finished run | Exact run identity, its recorded completion, and the agent observed idle with no active turn or pending permission | implemented, Spec 050 |

Budget: every read goes through the existing admission classes; no new provider
integration is added for any of it; at most one read per fact per escalation
attempt; and a live read adds evidence at a decision point without replacing a
durable record.

## Transient provider failures

A retained worker, reviewer or coordinator thread can hit a temporary 429 rate
limit, 502/503 service error or 529 overload. Every 429 that is not quota
exhaustion backs off in place, even without an explicit rate-limit phrase
(GLM's `{"code":1302,"message":"Rate limit reached"}` carries no such
phrase). Nucleus keeps the same thread, run,
callback identity and exact head, then sends one authenticated continuation
after the provider's explicit `Retry-After` or the bounded 1-minute, 2-minute,
4-minute, 8-minute backoff. Nucleus persists each continuation intent and stable message ID
before delivery; uncertain delivery goes to attention and is never replayed
blindly. After four same-thread resumes, a further non-rate-limit transient failure raises
attention with the provider evidence. A further rate-limit failure routes to
another eligible profile at the same capability (an allowed model change under
Spec 057/058) instead of parking: the exhausted subscription group is out,
not the whole provider, preferring another provider but accepting another
eligible group on the same one. Nucleus records a short cool-down for the
rate-limited subscription group in capacity state (the provider's own retry
time when given, else five minutes) so new launches prefer other eligible
profiles meanwhile, then arms the failover. Only when no alternate profile
exists at the same capability does Nucleus escalate to the planner, never to
operator-needed first. Explicit quota, credit or
usage-balance exhaustion remains on the existing failover path.

An explicit retained-author resume takes precedence over the initial worker's
transient retry. Once `restart role=worker` returns a task to `changes_requested`,
Nucleus must mint the normal authenticated revision run; it must not resume the
old initial ticket or reapply its missing-callback wait. This is checked against
fresh state before delivery and after awaited observations. Project-a #2328 exposed
the collision: the old ticket ran successfully but its callback was stale in
the resumed phase. Old callbacks and retry evidence remain immutable. Once the
existing PR is reconciled, an owner may use explicit `move to=work` with a report-only
instruction to obtain a genuine current result on the retained author, without
repeating implementation, checks or creating another reviewer.

A Pi worker launch whose output reports that `~/.pi/agent/settings.json` is
locked is also transient. Nucleus records the provider error, waits the bounded
first-step backoff, and retries creation once in the retained workspace only
after a successful exact lookup returns no agent and the workspace is verified.
An ambiguous lookup or a second failure returns to the existing recovery path.

## Rule 5: an unverified read is not an absence

**A confirmed absence requires a successful live read.** A read that fails,
times out, is refused or is unavailable yields `unverified`, and `unverified` is
never recorded or acted on as `absent`. Per outcome:

- **Failure or unavailability** — hold inside a bounded grace and retry,
  coalesced per identity in the shape integration-checkout contention already
  uses: quiet during the grace, one notice if it persists. The escalation
  records that the live check failed, so a later reader cannot mistake it for a
  confirmed absence.
- **Ambiguity** — never guess and never hold silently. More than one match is
  real identity conflict and needs a human: escalate naming the candidate
  identities, classified as operational uncertainty rather than coordinator
  judgment.
- **Capability absent** — proceed on Nucleus's own knowledge and record that the
  live check was unavailable, for the same reason.

## Rule 6: an answered escalation can be resolved

One versioned **operator-only** control, shaped like `resolve_escalation` and
carrying a required reason. It moves an escalated recovery and incident to
`resolved` with the operator's reason, keeps the escalation event intact as
history, settles pending attention notices and clears attention.

It is available only when no run is unreleased and the escalation is not backed
by live work. An active recovery, an unlanded merge intent, a working lane —
including an `awaiting_review` first-review wait — or a current fault that would
reopen the episode is live evidence. A refusal names an unreleased run's role, the active recovery, merge, task lane and phase, or unresolved attention fault
that still owns the task. The escalation's own existence is not. The narrow
working-lane exception is `verifying` with
attention clear, no current run, a ready-for-review completion, and a
`ready_to_merge` review at the task's exact PR head. Its escalated recovery must
report that no resolution action needs retry and identify the current escalated
incident. The answer leaves the phase unchanged; the pre-merge gate runs on the
next pass. A no-action escalation in `merging`, `syncing` or `closing` remains
refused. It is not available to a coordinator, and it never happens
automatically on disposition: the disposition answers the task's outcome, not
necessarily the escalation's question, and closing on that basis would erase
the record that a coordinator flagged something real.

The former first-review exception (the #2568 capacity-only closure and the
#2611 same-run stale-stall closure) was deleted on 2026-10-14 (Spec 050 step
4): an answered first-review escalation is settled by the owner verbs instead —
`move to=review` starts the owed independent review at the accepted head and
supersedes the escalated episode with history kept, `restart` covers the
stalled-run cases, and the verb settlement decides liveness by observing the
agents rather than a read-only proof tuple. `resolve_escalation` keeps its
ordinary live-work gate; a first-review wait is live work, so the control
refuses it and names the verbs that apply.

## Rule 7: a stalled turn has an explicit stop boundary

Stall detection records the exact Nucleus run and the active Paseo turn ID on the
incident. It remains a visible owner-held blocker; detection never interrupts,
replaces or resumes the thread. `stop_stalled_turn` is a versioned operator
control that requires the same incident run, task version, assigned agent,
workspace and detected active turn to match a fresh live observation. It refuses
when the turn changed, identity is missing, a permission is pending, or Nucleus is
paused or dispatch-held.

Nucleus persists a stable stop intent before calling Paseo's active-agent
cancellation endpoint. That endpoint sends no follow-up message, so stopping a
turn does not itself create a continuation or reviewer verdict. If delivery is
uncertain, the run and lease stay held. A later explicit control first observes
the same active turn again; only that proof can authorize the single bounded
retry. If the agent is active on another turn, Nucleus leaves that turn alone and
keeps the original run held for owner inspection.

Nucleus releases the run only after a fresh observation reports the assigned
agent inactive in its recorded workspace, or after an authentic callback has
been retained and the agent is observed inactive. A missing callback does not
become a result, verdict or approval. The task stays in attention with the
concrete retained-run cause. Nucleus starts no replacement reviewer, worker,
checkpoint or publication. The owner may then choose an existing explicit
owner verb, such as `restart`, `move` or `route`, subject to their normal identity, head, workspace and dispatch
checks.

`replace_stopped_reviewer` may carry an optional `reviewer:
{profileId, reason}`. When present, Nucleus preflights that exact profile
whole-control — catalog, reviewer role, task scope, thinking option and
subscription-group availability — and requires its model to be concrete and
different from every actual author model recorded for the head under review. It
then proves the open ready PR, the pushed branch head and the clean retained
worktree all equal the recorded head. On that explicit route it also proves the
stopped reviewer's timeline shows no live shell command or running tool call:
the [shared bounded reader](../contracts/orchestration.md#owned-tool-evidence)
must retrieve the complete history or reach back past the start of the stopped
turn. An unavailable, unverified or incomplete read refuses with the exact gap.
It rechecks the task, the complete run snapshot, the run's task and workspace
binding, every other run lease, pause and
dispatch/disposition fences and named-profile eligibility after every await and
again inside the atomic closure. After the final reviewer observation, it
repeats the complete retained-author inactivity, permission and tool proof; only
synchronous durable rechecks and the transaction follow. An unresolved reviewer
continuation or delivery effect refuses only on that route; a delivered
continuation is settled history, and the omitted-reviewer path keeps its
historical behavior. The transaction
supersedes only the proven stopped callback-free run, revokes only that run's
credential, records the superseded run and head, the old and new reviewer
preference and the operator reason on a `reviewer_replaced` event, and returns
the same task, PR and head to ordinary `awaiting_review`. The explicit route
also records truthful provenance on that event: the trusted local operator
control boundary plus the supplied reason. The engine refuses any
caller-asserted actor, relay or note field and names no caller or relay identity
without trusted invocation evidence; a project owner's ownership is never
substituted for the invoking caller. The reviewer-omitted route keeps its
original event with no actor payload, so no `operator (board)` actor is
manufactured for a path that never had one. The operator reason in
`reviewer.reason` and the reviewer lineage (superseded run and head, old and new
preference) remain audit data. No attribution is ever hardcoded, invented or
trusted from an unverifiable caller. The old reporting
ticket is removed only after that transaction commits, so a failed or
interrupted operation never alters callback evidence without the replacement
landing. The single post-commit wake can therefore select only the
new route: the exhausted old route is never an intermediate dispatch candidate,
and no worker turn or verdict is created. With `reviewer` omitted the existing
behaviour is unchanged. A frontier or above-ceiling profile still needs its real
per-role reason. An absent, unavailable, disabled, wrong-role,
wrong-scope, incompatible-thinking, opaque, same-author, excluded or changed
profile refuses the whole control; Nucleus never substitutes another model. The
replacement owns its complete personal reading, checks and five-gate verdict —
nothing is inherited from the stopped reviewer.

The Nucleus owner's declared-route disposition keeps task-wide named replacement
bounded to routes it can actually bind. If the canonical brief declaration and
current stage index or typed reviewer-run stage identify a review/verify stage
with its own profile, the explicit control refuses before external proof or
mutation and names the stage, reviewer run and declared profile. That profile
cannot be overridden by a task-wide request. The declaration, stage state and
run-stage identity are rechecked after awaits and at the transaction; route drift
refuses without replacement or wake. Titles and stage-like labels are not route
authority. The reviewer-omitted path keeps its existing behavior, including the
normal retired-step hold; this refusal never re-enables declared execution or
changes Spec 043 binding semantics.

A second explicit opt-in on the same control, `retireCheckpoint`, retires a
reviewer that is positively stopped on its latest authenticated checkpoint
instead of through the missing-callback path. It supplies the exact latest
ordinal, authenticated checkpoint event and digest; the transaction reuses the
canonical receipt, file, run and event provenance proof, requires the unchanged
brief, no accepted completion or verdict and no unresolved continuation, and
refuses any open attention, recovery, permission, live tool or other lease. The
omitted option keeps the historical missing-callback precondition unchanged. The
old checkpoint, receipt, authorization, delivery and accepted-review history
stay immutable as superseded history; the named reviewer gets one ordinary fresh
independent substantive review with its own reading and verdict, never inherited
reading or pass credit. A companion `retireIncident {incidentId, recoveryRunId}`
closes only a proven escalated reviewer missing-callback incident naming a
released **superseded** old run and its **finished, released** recovery run,
both belonging to the current task, whose escalate completion
is the real authenticated receipt chain (stored accepted receipt hash of the
canonical completion with matching accepted response event identity, plus the
matching action run/report status/summary/action and the actual task-bound durable
`recovery_action_bound` event emitted by completion acceptance), never a plausible completion written directly onto the run. Unrelated,
current, newer or partial lineage refuses with no mutation; with the companion
omitted any open incident refuses. The retained author is positively observed
inactive, permission-free and free of an owned live shell or tool through a
complete bounded timeline read — a missing capability, unreadable page, gap or
unproven latest-turn coverage refuses rather than inferring idle tools. No durable
operation, hook, merge, validation or publication effect may be unresolved. The closure event
records the prior incident, recovery, old-run, recovery-run and action statuses,
the verified report receipt identity/digest, distinct durable action-binding event
identity/digest and action-record digest, and the supplied reason alongside the
checkpoint retirement lineage. Resolved historical incident/recovery records
remain untouched when the companion is omitted. Former reader and recovery
threads require positive identity, workspace, inactivity, permission and complete
tool evidence too; an accepted old callback, newer fault or uncertain historical
delivery refuses the whole retirement.

The Nucleus owner’s bounded completion ruling after review round 18 requires this
accepted report/action/event chain and owner-independent local control provenance.
Ownership supplies no invocation identity or idle requirement; the retained
author and retiring reviewer still require their own live inactivity/tool proof.

### 2026-10-13 operator ruling

Tom answered verbatim "Yes" in the Nucleus owner thread to: "do you authorize
implementing, independently reviewing and delivering that bounded fix?" This
supersedes the atomic explicit-stopped-reviewer brief's preparation-only
boundary for this remedy only. It authorises implementing that bounded brief,
recording this ruling and the skill update in the same PR, focused validation,
independent exact-head review and CI, then normal merge and closeout. Nucleus
owner delivery remains a supported plugin-only reload from verified clean
merged source after typechecking; no Paseo or daemon restart. Implementation
and review workers do not operate the ten consumer tasks: their conditional
one-replacement authority and named GLM High preference stay bound to a fresh
identity, head, idle, tool, permission, effect and policy preflight after the
reviewed capability is installed. No authority is granted for the separate
workerless-owner-revision lead f246746e/decision 21b67fc0, native MinIO replay,
consumer hold release, provider reset or a widened routing refactor.

### 2026-10-13 source-owner compatibility ruling

The immutable pre-change baseline for `replace_stopped_reviewer` is planning
commit 46a8c0f9b3e1aeec4bc54423c2950e785553f62b, also merged main
2c3dfba0f9e28fe3bae8e079911b9fd37ee12ec6. At both, `bin/queue-cli.mjs` is
byte-identical (sha256
7870655b3bffe3cf0172201683feecf4ad369c96dcb87aa269812ebee270abd5), injects no
actor for this action, and the engine dispatch passes only `taskId` and
`version`; the schema rejected `note`/`relayed` on the reviewer-omitted route
and the original `reviewer_replaced` event carried no actor payload. Earlier
unmerged PR426 revisions are not a compatibility baseline, and the unmerged
legacy relay injection is not restored. Trusted local control provenance and the
supplied reviewer reason belong only to the explicit reviewer route; the
reviewer-omitted route preserves its original event semantics without
manufacturing an `operator (board)` actor, and a generic unused actor field is
never trusted as attribution. The explicit route records only
`trusted_local_control` provenance and the supplied reason. Project ownership
does not authenticate the caller and neither owner metadata nor owner inactivity
is required. The control refuses any caller-asserted actor, relay or note field; the reviewer-omitted route refuses those fields too
and keeps its original unattributed event.

### 2026-10-13 operator ruling — a reviewer's own timeline refusal

Tom asked the Nucleus thread through the web owner to resolve papercut
`0d07f2d4-f965-414e-ad61-c1313b8abcb4`, and selected the task-only GLM route for
that flow. Existing Tom blanket implementation, independent-review and delivery
authority applies; this records the ruling in the same change rather than asking
again. It is separate from the atomic explicit task-only reviewer replacement
(Spec 016 rule 7 / PR426), which it does not re-open or duplicate.

A current reviewer whose provider plan or quota is exhausted can answer its own
dispatch turn with a terminal refusal and never reach its authenticated
callback, so Paseo's observed agent error stays empty and the reviewer reads as
a stopped thread. Rule 4 now reads that reviewer's own identity-bound timeline:
the `ns-run-<runId>` dispatch message names the run, and the terminal provider
response after it in the same turn must be the canonical Cursor plan refusal or
a genuinely attributed quota/balance error. Quoted user, prompt, tool-output or
document text, a foreign run or provider, an older resolved response, a partial
or gapped page, a running tool, or a non-terminal response is not evidence, and
every unproven read stays `unverified`, never absence. Ordering requires readable,
distinct timestamps for every turn entry; page order cannot resolve missing or
ambiguous timestamps. An unverified read leaves the lease held and surfaces its
bounded coverage, attribution or ordering gap instead of sending a callback
reminder (bounded since 2026-11-01, see the amendment below).

On proof, one read-only selection proves an eligible independent reader exists
with the proven subscription group excluded. The exact stopped reviewer is
re-proved first — same agent, same task workspace, assigned provider and model,
idle or closed, no turn, no permission and no unresolved effect — and the live
open PR, clean local worktree and pushed branch head must still equal the
recorded head immediately before the one transaction that records the redacted
refusal, marks only that group unavailable and supersedes the run. The refused
reviewer is observed again after those awaited revision proofs, so a new turn
or permission request keeps its lease. No further await separates that final
live observation from the transaction. The eligible reader is re-chosen then
and revalidated again synchronously inside the transaction, so a route that disappears during the
proofs is never superseded onto. Ordinary selection can then never re-dispatch
the exhausted route and the one bounded callback reminder is skipped. A
conflicting or unobserved provider/model, a changed task version, run or
workspace identity, a closed or drifted PR, a dirty or unpushed worktree, or an
unavailable live read refuses and leaves the lease, credential and history
untouched. Without an eligible independent reader the run keeps its lease,
credential and history, the proven group is not attributed, and the task shows
a finite blocker naming the missing eligibility. Every stored diagnostic is
bounded and redacted, so a credential or secret in the provider text is never
persisted. The new reader owns its complete brief, checks and five gates;
nothing is inherited from the refused review.

### 2026-11-01 amendment — an unverifiable refusal read is bounded (queue #535, papercut fe93582a)

The 2026-10-13 ruling held the reviewer on an unverifiable refusal read and sent
no callback reminder. On a provider whose timeline never carries the
`ns-run-<runId>` dispatch message id, that read can never settle, so a reviewer
that had finished its work held its lane indefinitely: no continuation, no
restart, and a `provider_unavailable` wait nothing could clear.

An unverifiable read is still never evidence and still never releases the lease.
It is now bounded: the check spends two reads, each recording its exact gap once,
and then the run belongs to the ordinary stopped-without-verdict path — one
bounded continuation of the retained reviewer asking it to re-report, then the
existing fresh-restart rule. The provider wait that check recorded is retired
with the handover, no further timeline read is spent on that run, and no
subscription group is marked unavailable: an unproven read never attributes a
refusal.

### 2026-11-02 amendment — an oversized prompt is refused before send, and no reminder fires without a delivered dispatch (queue #547)

A review prompt larger than the provider's input limit is not an uncertain
delivery. A provider error naming its input/maximum-length bound (or an
equivalent explicit "too large" rejection before acceptance) settles the run
as refused before send: the run is superseded and released with a pre-send
receipt (`review_prompt_refused_before_send`), never `uncertain`, and quota,
plan, rate-limit or transport wording never qualifies. The next attempt
dispatches the bounded prompt below.

The #535 continuation above is further narrowed: the missing-callback reminder
only fires when the dispatch message (`ns-run-<runId>`) is positively in the
reviewer's timeline. A complete timeline page without it proves the dispatch
was never delivered, so the reminder — which asks the reviewer to submit its
existing result — never fires; one `callback_reminder_skipped` event records
the miss and the task parks for the ordinary relaunch. Anything less than a
provably complete page without the dispatch (a gap, older pages pending, an
unreadable page) stays unverified and keeps the existing reminder path.

## 2026-11-12 amendment — a thread waiting on its own job is liveness (papercut 6895edaa)

The missing-callback decision reads the stopped thread's own provider timeline as
one more live fact. A latest tool call that is still `running`, of a kind that
can outlive its turn (a background shell, a timed test run under a Monitor, a
worktree setup), proves the agent is waiting on its own work; the task records
that wait, extends its reminder grace and starts no reminder, incident or
recovery run over it. Turn-bound kinds, terminal states, unrecognised statuses,
ambiguous simultaneous states and unreadable pages are not liveness, so an
ordinary stopped thread keeps the existing reminder and recovery path.

## Rule 8: a stale superseded reviewer incident settles with its owner control

The separate `close_superseded_reviewer_incident` control was deleted on
2026-10-14 (Spec 050 step 4): an owner verb (`restart`, `move`) settles a stale
reviewer `missing_callback` incident, its escalated recovery and the pending
attention in its own transaction, with the original detail kept as history and
one `owner_control` event naming what it superseded. The historical closure
records below stay readable.

The retired control proved the exact escalated reviewer missing-callback
incident, its finished released authenticated `escalate` recovery with no bound
action, and a positively idle old reader and recovery thread before it resolved
only that incident and recovery. A verb refuses instead when a finished run of
another role still fences it (no recorded completion, or the agent observed
active); a live lease is never closed by settlement, and ordinary
`resolve_escalation` keeps its strict behavior.

## Bounded changes implied

- **Rule 1** — already implemented for the branch-PR case; this note makes the
  principle the authority rather than the patch.
- **Rule 2** — already implemented; the lane owes a rule-level regression test
  rather than another behaviour change.
- **Rule 3** — implemented by g01.034. The disposition terminal transition
  clears the attention episode and unsettled notices, while resolution-run
  observation, notice delivery and recovery routing skip completed
  dispositions.
- **Rule 4** — one gap to implement: re-read the retained worker's binding and
  stopped state before escalating a reporting-identity mismatch. The rest of the
  list records behaviour that already exists.
- **Rule 5** — implement the `unverified` outcome and its bounded hold, the
  ambiguity classification, and the recorded unavailability.
- **Rule 6** — implement the operator-only resolution control.
- **Rule 7** — implement the exact-turn operator stop, durable uncertain
  delivery record, inactivity reconciliation and retained-completion path.
- A bounded **report**, not a change, of any other gate that retires a
  live-evidence instrument on one empty result.

## Acceptance oracle

Tests are per decided rule, not per incident:

- A completed disposition leaves no attention episode, and a subsequent pass
  derives no notice, no recovery run and no coordinator from the disposed task.
- A recovery or notice pass over a disposed task is a no-op, including when the
  task still holds a merged commit and a past escalation.
- An instrument that decides from live evidence re-attempts with a backoff
  stepped in bounded-grace multiples and does not repeat inside a step, and a
  first empty result does not retire it — held for the branch-PR lookup and for
  any newly found instance. A repeat whose outcome is unchanged coalesces onto
  a per-task counter instead of the event log.
- A fault that conceals its own evidence consults live state before escalating;
  a fault that does not still escalates from Nucleus's own knowledge.
- No new outbound call is made on a path that conditions 1–3 do not cover.
- Rule 4: only the listed facts are read live, each at its decision point, at
  most once per escalation attempt, and no new provider integration appears.
- Rule 5: a failed, timed-out, refused or unavailable read is recorded and
  acted on as `unverified`, never as absence; a retry happens after the bounded
  grace and is quiet inside it; an ambiguous match escalates with its candidate
  identities named and is classified as operational uncertainty.
- Rule 6: the resolution control is rejected for any caller that is not the
  operator, is rejected while a run is unreleased, and leaves the escalation
  event intact after it resolves the incident.
- Rule 7: detection retains the run and observed turn identity; the operator
  stop re-proves that identity and refuses changed turns, permissions, pause
  and dispatch holds. Unknown delivery can retry only after the same active
  turn is observed again; inactivity releases the lease without inventing a
  result or launching replacement work, and an authentic callback is retained.

## Decisions taken

### 2026-09-20 operator recovery addendum (g01.040)

A branch PR discovered after a retained revision's delivery became uncertain is
live evidence that Nucleus can accept only through an operator control. For a task
with no accepted PR identity, `adopt_replacement_pr` requires escalated attention
and the stopped retained worker in the recorded workspace. It checks that every
unreleased run is a callback-free revision on that worker and workspace with
recorded missing-callback or uncertain-delivery evidence. The control requires
exactly one matching open branch PR and reuses the clean worktree, repository,
branch, base and exact-head checks. It repeats identity and head checks before
releasing those run leases and binding the PR in one transaction. Each run keeps
its status and head. The same worker receives one authenticated confirmation
run; independent review still follows its accepted callback. Reconciliation
does not take this operator action automatically.

If two faults recur on the same run, the task keeps its first unresolved reason
while the other fault is recorded once in the event history. A new run may
establish a new reason. This stops version churn without concealing the second
fault or changing live-evidence escalation rules.

The three policy questions this note originally left open were decided on
2026-09-17 and are now rules 4, 5 and 6 above. They remain operator-owned
policy — the note records them, it did not choose them. Nothing here authorises a
lane to extend the list in rule 4 or the outcomes in rule 5 without a new
decision.

## Exclusions

No new external dependency, and no provider integration beyond the reads listed
in rule 4. No live fetch outside that list, and no additional fact read without a
new decision. Recovery still cannot approve a PR, bypass merge checks or
broaden a handoff. No consumer repository edit and no retroactive repair of
historical incidents. Rule 6 and the 2026-09-20 addendum are operator-only and
evidence-preserving. Spec 049's reconcile-and-continue classifier (retired
2026-10-14) read those same live facts; Spec 050's reconciler and owner verbs
replaced it without widening rule 4.

## Retired author upgrade policy

The [orchestration contract](../contracts/orchestration.md#non-converging-review-ladder-spec-058-cutover-3)
records the current rule: review history never upgrades the worker automatically.
Spec 058 cutover 3 retired the three-review capability upgrade. Historical rows
and events remain readable; a planner who wants a stronger worker uses
`route role=worker`. The six-round cap escalates to the planner ladder.
