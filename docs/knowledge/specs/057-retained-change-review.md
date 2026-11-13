# 057 — Retained change review and source approval awaiting proof

Status: ordinary-task cut implemented; ordinary pinned advancement remains B later
Owner: Nucleus runtime maintainers
Created: 2026-10-31
Decision: [vision — Retained reviewers review changes](../vision.md#retained-reviewers-review-changes)
Governing refs: [Spec 037](retired/037-structured-review-verdicts.md)
(retired 2026-11-02; verdicts remain ordinary reviewer evidence),
[Spec 050](050-owner-task-controls.md) (owner verbs),
[Spec 054](054-required-proof-admission.md) and
[Spec 055](055-source-immutable-proof-executor.md) (required proof),
[orchestration contract](../contracts/orchestration.md).

## Problem

Fourteen days of live data (2026-10-17 to 31): 1,771 reviewer runs for 341
reviewed tasks, and almost as many distinct reviewer agents. Every revision
round starts a fresh reviewer that re-reads the whole change; the re-review
prompt tells it to "freshly judge every subject from current-head evidence".
It has the earlier verdicts as JSON but not the code it read or the delta
since then.

452 reviews ended `blocked`, most for an owner-gated proof while the source
was clean. One project-c task ran 60 reviewer runs over 48 heads, 46 of them
`blocked` on the same missing native proofs: each head move bought a full
fresh read that ended where the last one did.

## Design

### 1. The retained reviewer reviews the change

After an applied `changes_required` and a worker report at a new head, Nucleus
sends the next review to the reviewer agent that issued it.

- **New run, same agent.** The round is a new reviewer run bound to the new
  exact head, with its own credential, on the retained agent and workspace.
  It records `priorRunId` and `priorHead`. Exact-head binding, receipts and
  verdict rules are unchanged.
- **Prompt.** The turn carries references, never diff content (Tom,
  2026-11-01): the reviewer's own earlier `reviewText` and verdicts (bounded),
  the brief versions, the exact prior and new head SHAs, the base movement,
  the diff stat, the changed files, and the exact commands to read the delta
  in the checkout — `git diff priorHead..head` and `git range-diff` of the two
  merge-base ranges. No delta or range-diff text is inlined at any size; the
  reviewer reads the delta with git in its own checkout. It checks each
  earlier finding is fixed, reviews new and changed code, re-judges any verdict
  subject the delta touches, and reports a full verdict at the new head. It
  may read beyond the delta when the delta warrants it.
- **When it is fresh instead.** Nucleus starts a fresh reviewer when:
  - the retained agent is closed, unobservable or not idle;
  - its profile is disabled, unavailable or no longer independent of every
    actual author (an author upgrade changes the author);
  - an owner asks (`restart role=reviewer fresh`, or `move to=review` with no
    continuable reader);
  - three consecutive rounds were retained (the independence check: the fourth
    is fresh, then the count restarts). Tom kept this rotation when workers
    became single-thread (Spec 058, task 577): "Keep the rotation" (2026-11-02);
  - the provider reports the reviewer out of context.
  A swap by any of these conditions records which one failed — `round`,
  `participant`, `runtime`, `context` or `error` — with the observed evidence in
  its `reviewer_fresh_agent` event, and `task.next` reports the same
  `reviewerSwap` observation so the project can judge whether the replacement's
  verdict is its one counted review (papercut 8fffbf59).
- **Revision budgets are unchanged.** The six-round cap counts review rounds, not
  reviewers; Spec 058 cutover 3 routes non-converging reviews to the planner and
  removes automatic author upgrades.

### Placement (Tom, 2026-11-02)

- **Ordinary Nucleus tasks:** the retained reviewer keeps its own review
  workspace. Before the next round, Nucleus moves that workspace's detached checkout to the new exact
  head and verifies a clean tree, the exact HEAD and the open PR head at send time, as continuation
  does today. No new workspace or view.
- **Review-entry tasks (Spec 017):** use the same task workspace and retained
  reviewer rotation. Nucleus waits for the origin writer to yield, then proves the
  clean checkout, exact HEAD and open PR head at every send. No round creates a
  pinned view. The task workspace supplies later source proof.
  Dated receipts retain their actor, source, permission and canonical PR proofs.
- No carrier workspace and no per-run child views.

### 2. A head move with an empty range-diff

When the new head's `range-diff` against the last reviewed head is empty (a
pure rebase), no content review runs. The retained reviewer, or a fresh one if
none qualifies, gets a confirmation turn: a pure-rebase note, the base
movement and the covering checks at the new head; the range-diff command in
the prompt lets the reviewer confirm the unchanged series itself. It reports a
verdict at the
new head without re-reading the change. Exact-head review still gates the
merge; only the reading is skipped.

### 3. Source approved, awaiting proof

A reviewer that finds the source ready but a required proof missing for a
reason the author cannot fix (owner-gated, an external capability) reports
`blocked` with `reviewResponsibility: environment`, `sourceApproved: true` and
`awaitingProofs` naming the missing proofs. On a responsible task each name
carries the route that can produce it, and Nucleus sends it there before this
wait: an author-tagged proof returns to the author, an environment-tagged one
gets one clean retry, and only an external proof parks here
([Spec 058](058-responsible-tasks.md) slice 8).

- Nucleus records the source approval at that exact head and parks the task in
  one typed stop, `awaiting_proof`, with one notice to the project owner
  naming the proofs. No coordinator episode opens and the author is not handed
  the task.
- When the proof evidence lands at the same head (a Spec 055 execution
  settles, or the owner records it), Nucleus sends one proof turn to the
  retained reviewer, or a fresh one if none qualifies: judge only that
  evidence against the brief. The source approval stands; the verdict is the
  merge gate as usual.
- A passed, released Spec 055 execution satisfies an awaiting entry when its
  selector matches the entry, or when it matches the task's single declared
  `queue.proofExecution.selector`. Prose descriptions may therefore name the
  declared selector without being an exact command string. The approved head,
  branch, PR, brief digest, executor release and `proof_executed` pass remain
  required.
- A head move while parked voids the source approval and returns the task to
  the author for authenticated readiness at the newly observed head. Only that
  released author report advances to independent review; a reviewer is never
  launched against the stale recorded head.

### Authenticated review application races

An accepted reviewer completion is retained on its released run before the
task-side review is applied. If application fails transiently, the next
lifecycle pass re-applies that stored completion while its accepted callback
receipt, released run, retained reviewer identity and exact PR head still match
the task. An attention retry requires an incident for that run after its
completion; when publication is recorded, the incident must follow the
publication event too. The incident may since have resolved, and a refused
coordinator action does not disqualify the retained verdict. If no publication
ID or intent was recorded, replay publishes and verifies the verdict before
applying it. An uncertain publication record or a later explicit owner stop
keeps an unpublished result parked for its existing reconciliation path. A
pending planner escalation with known delivery also parks it unless its cause
matches the interrupted incident fingerprint; that matching escalation is the
same failure being repaired, while an unrelated escalation remains in charge.
Incident wording does not decide eligibility. A fresh review or return to the
author supersedes the pending application. The task-side review update and
`review_reapplied` event commit together; all applied-review readers recognize
that event as an application marker, and later passes do not apply it twice.
Successful retry also settles the attention episode, incident, recovery run and
stop caused by the failure. `retry_effect` is offered for review publication
only when a retained publication intent exists for it to reconcile and no later
same-head verdict has superseded it. Custody
compares the active run and current PR head rather than rejecting an unrelated
task-version change.

### Superseded uncertain publications

Once a later reviewer run of the same retained reviewer at the same head has
been published (a positive publication ID) and its verdict applied, an earlier
run's uncertain publication is superseded history: the shared classification
records it `superseded`, it blocks nothing, and the task merges through its
ordinary turn. The superseded effect is never re-published or retried — unknown
delivery is never retried — and if the forge later shows the earlier review too,
it is harmless history. Verdict conflicts need no reconciliation: only the
later applied verdict governs review state and merge, and the earlier unapplied
report stays durable history on its run. An uncertain publication with no later
applied verdict, or one whose later applied verdict sits at a different head,
keeps blocking (task 667).

## What this removes

- The fresh-reviewer default per round and the full re-read it pays for.
- The blocked → coordinator → `move to=work` → new head → fresh review loop on
  owner-gated proofs.
- The rule that a new reviewer owns its reading (vision) and the per-head
  fresh review in the orchestration contract, already superseded there.

No new verb, enum beyond `awaiting_proof`, setting or ledger. The retained
round reuses the existing retained-reviewer identity proof
(`reviewerIdentityAtHead`) and the existing dispatch path.

## Implementation boundary

Ordinary rounds retain the recorded reviewer and workspace. A new run and credential
carry the prior run/head, the exact base and head SHAs, earlier findings, brief
versions, the diff stat and changed files, and the `git diff` / `git range-diff`
commands that read the delta in the reviewer's own checkout. No delta or
range-diff text is inlined at any size (Tom, 2026-11-01). The shared prompt
budget (200 KB) bounds long reports only — the review text in revision
instructions, the joint operator question and the decider context.
The shared checkout detaches only after custody and source checks, and returns to
its recorded author branch after release; dirty, moved or still-owned source refuses.
A bound ordinary reader is not archived just because its verdict was applied.
A closed reader gets a fresh replacement, and an errored reader with no active turn and no pending permission gets one too: it cannot receive the round, so custody admits it like a closed participant and the round goes fresh. These rules replace the old archive-after-
verdict and closed-agent reuse expectations.

In-process launches keep ownership of their reserved run until preflight and the
native response settle; a concurrent observation cannot mistake that interval for
unknown delivery. A restart has no such local ownership and still reconciles the
persisted intent. Refreshing a released run's observation telemetry does not change
its identity, result, deliveries or custody, all of which remain fenced.

Source approval uses the authenticated blocked review itself, rather than a second
approval ledger. `awaiting_proof` keeps that stop out of recovery and sends one owner
notice. The existing owner `proof` activation may run from that stop, with its
per-head allowance and source gates; a passing same-head settlement then receives
one independent evidence-only round. An evidence-only round that remains blocked
does not redeliver the same execution. A failed proof followed by an authenticated
author revision and retained-reviewer source approval at a new exact head earns
one new proof execution there; the old receipt remains unchanged, and another
attempt at either used head refuses. A moved head invalidates the source judgment
and still needs normal authenticated readiness and exact-head review.

## Acceptance oracle

Isolated scenarios, never a live consumer:

1. `changes_required` → worker reports head H2 → the second review run is on
   the first reviewer's agent, carries `priorHead` H1, and its prompt holds
   the earlier findings, the exact H1/H2 SHAs and the git commands to read
   the H1..H2 delta, with no diff text inlined.
2. A closed reviewer agent, a planner-routed worker replacement, a fourth consecutive round and
   an owner fresh restart each produce a fresh reviewer.
3. A rebase-only head move produces a confirmation turn for the unchanged
   series and a verdict at the new head.
4. `blocked` with `sourceApproved` parks in `awaiting_proof` with one notice
   and no coordinator run; a settled proof at the same head produces one
   proof turn; a head move voids the approval.

## Proof-only qualification of merged source (task 551)

A release-gate qualification may target a commit already merged to the task's
base branch. Its Nucleus-held brief declares both `queue.proofOnly: {commit}` and
the ordinary `queue.proofExecution` selector and input hashes. Promotion proves
that the named commit is an ancestor of `origin/<base>`; a missing commit or a
commit outside that ancestry is refused before task creation. This task has no
author, task branch or pull request. It uses the ordinary source-immutable
executor admission and receipt, pinned to the named commit, and the one
execution allowance is never retried or refunded.

If the brief declares `queue.requiresOperatorGo`, it names the live surface the
qualification will touch. Nucleus asks one native `release` question on the task
and does not admit the executor until the operator answers GO. This kind is
operator-only; planner and decider delegation are forbidden. A no/declined
answer leaves the qualification unexecuted and records the task as failed.
Without the declaration (task 574) the qualification is a synthetic one the
planner already authorized: Nucleus raises no release question, binds no GO
evidence, and the executor prompt demands none — the executor runs the
selector directly. The `proof` owner verb activates such a qualification from
`queued` or after a pre-selector refusal, with no PR head to name.

After the executor settles, the retained reviewer receives one evidence-only
turn with the exact receipt. A passing judgment closes the task `done` and
retains the receipt as release evidence. A failing proof or reviewer judgment
closes it failed with the recorded failing cases, so the planner can brief a
fix. There is no worker revision loop, dummy PR or reopening of a merged task.
