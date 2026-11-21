# Spec 067 — Explicit resolution

Status: proposed (planner, 2026-11-21). Awaiting Tom's approval. Supersedes the
proof rules in [Spec 066](066-one-reconciler.md) named under
[What changes in earlier specs](#what-changes-in-earlier-specs).
Audience: queue implementers, reviewers, planners and coordinators

## Outcome

Tom, 2026-11-21: "tasks just simply should not get stuck — the coordinator
should always have the tools to get it going again, no matter what. The only
time a task should be blocked is when it comes up against a problem with the
work it's doing and needs to ask the planner or me about it."

And: "if the commands are strong enough and the gates can be overridden, there
shouldn't ever be an unrecoverable state for a task. We shouldn't need to
supersede and tidy up." And: "The commands should be explicit and absolute so
there's no guesswork. The current surface is fine for normal flow, but we need
to expand it to allow tasks to explicitly resolve issues on a general basis."

So Nucleus has two layers:

1. **Normal flow, unchanged.** `next`, `restart`, `route`, `move`, `stop`,
   `complete`, `retry_effect`, holds and the rest drive the ordinary lifecycle.
2. **Explicit resolution, new.** A small set of commands that each do exactly
   what they name, immediately, with no implicit follow-on and no proof
   requirement. Every gate is a named warning the caller accepts with a reason.
   Only two gates are hard.

A task is blocked only by a question about its work. Every mechanical state —
an uncertain launch, an unread timeline, a tool still running, a stale binding,
a held turn, a host wait — is something a coordinator, planner or the operator
can resolve in one explicit step.

## Why

Five simplification rounds since October each added proof machinery: an
uncertainty became a holding record, and a holding record cleared only on a
positive proof that could fail to arrive (exact lookup, grace period, pre-send
receipt, idle observation, timeline read, unchanged binding). The audit in
planner scratch (lifecycle map, refusal inventory, complexity measures) found:

- Uncertainty-only code grew from 12.2k to 33.1k raw lines (16.6k to 25.7k
  line-equivalents) between 2026-11-11 and 2026-11-21; Spec 066's sixteen
  delivered slices added about 3,200 net lines, each a narrower proven exit.
- `retry_effect force` records a settlement but never releases the run, and
  the run fence reads the run's own status, so every verb keeps refusing
  (`core/verbs/force.ts:113-149`, `core/intake/run-settlement.ts:26`).
  `restart` and `route` accept no force (`core/verbs/dispatcher.ts:213-232`);
  `route now` re-runs the exact lookup with no override
  (`core/verbs/route.ts:488-504`).
- `next` can offer a verb whose execution refuses and names another verb that
  refuses back (underlay#046: `restart fresh` → "continue that reviewer" →
  "delivery unknown" → "restart").
- Coordinators never launch for "waiting" stops (`shared/task-stop.ts:61-66`),
  and the uncertain-creation wait is filed as one, so no role is ever asked.
- Escalation answers bind to a snapshot hash; any run or PR change refuses
  every answer, answers cannot carry force, and nothing closes an escalation
  when its cause clears (`core/questions/escalation-settlement.ts:296-300`).
- Decisions read prose: several paths match `stop.detail` or `task.reason`
  text (`absent-creation/decisions.ts:22`, `restarts.ts:63-72`,
  `responsible-fault.ts:39`, `integration-turns.ts:204`).
- One 60 s host-call timeout marks the whole host down and stamps a host wait
  on every live task, with no override (`core/host/adapter-routing.ts:160-180`).
- A prerequisite wait does not give up the integration turn
  (`core/merge/integration-turns.ts:59-66`): oxide#361/#362 deadlocked silently.

Overriding a gate has a visible, fixable worst case for every external effect
(audit table C §2): a duplicate thread or prompt, a duplicate review, a hook run
twice, a second turn holder. The merge is already guarded at GitHub by the
expected head SHA, and "already merged" counts as success (`core/forge/merge.ts:126-133`).
The only real hazard is two workers in one worktree, which the commands below
name as a warning and resolve by stopping the old turn and its process group.

## The explicit commands

Each command takes `taskId` (or `reference`), `version`, `reason`, and
`accept: [<warning ids>]`. Execution:

1. Reads current facts once and computes the warnings that apply.
2. If any warning is not in `accept`, returns them (id and text) and changes
   nothing. Repeating the call with `accept` applies it. There is no binding
   hash and no observation-advance check; a stale `version` returns the current
   one and the call can be repeated.
3. Applies exactly the named change in one transaction and writes one
   `owner_resolution` event: command, arguments, caller and source, warnings
   shown, warnings accepted, reason. Original records stay in history.
4. Returns the new state and what the scheduler will do next in that state, so
   no caller has to guess.

No command changes anything it does not name.

| Command | Does exactly | Warnings (overridable) |
| --- | --- | --- |
| `run.start role=<worker\|reviewer\|coordinator> agent=<retained\|fresh> [head] [instruction] [replacing=<run>]` | Creates one run for the role and delivers it: `retained` to the bound thread, `fresh` to a new thread on the role's route. `replacing` first applies `run.release` to that run. Phase unchanged. | `duplicate_thread` (another unreleased or uncertain run of the role exists), `two_writers` (worker only: another worker may be live), `head_mismatch`, `budget` (replacement ceiling or revision cap), `route_policy` (Spec 052 sign-off; not a coordinator's to accept) |
| `run.release run=<id> [archive]` | Stops treating the run as live: best-effort cancel of its turn and its recorded process group, `released=true`, revokes its credential, clears pointers to it, settles its delivery effects. Optionally archives its thread. Never launches or changes phase. | `live_turn` (agent may be mid-turn; a worker's uncommitted changes may be lost), `unreported_result` (its report will be refused) |
| `record.clear kind=<stop\|wait\|hold\|escalation\|incident\|effect\|host_wait\|owner_stop\|deferred_verb> id=<id>` | Removes exactly that record, including the underlying fact any fence reads (run status, operation state, notice state). | `hold_owner` (overrides another owner's hold; planner or operator only), `effect_may_land` (the effect may still complete or repeat), `owned_tool` (a process may still be writing) |
| `phase.set to=<working\|changes_requested\|awaiting_review\|reviewing\|verifying\|needs_attention\|blocked>` | Writes the phase and reason only. | `live_runs` (unreleased runs see an unexpected phase) |
| `message.send role=<worker\|reviewer\|coordinator\|planner> text` | Delivers to the role's bound thread now, steering into or queued after an active turn, and reports `delivered`, `queued` or `unknown`. Changes no task state. | `queued`, `no_thread` |
| `merge.now head=<sha>` | Requests GitHub's guarded merge of exactly that head now, taking the integration turn if free. | `turn_held`, `checks` (non-required checks failed or pending), `holds` |
| `turn.take` / `turn.release` | Takes or releases the repository integration turn for this task and wakes the tasks waiting on it. | `turn_held` (take displaces another task), `merge_in_flight` |
| `closeout.now [mergedCommit]` | Records the merge (from GitHub, or an operator-stated commit when GitHub cannot be read) and starts sync and closeout. | `unverified_merge` (operator only), `no_verdict` |

**Hard gates** (never accepted as warnings):

- `merge.now` and `closeout.now` need an applied review verdict at that head or
  an explicit operator source acceptance of it (AGENTS.md, Tom 2026-10-20).
- `merge.now` refuses while an earlier merge request's outcome is unknown,
  unless a GitHub read in the same call shows the PR unmerged.

**Authority.** The operator board: every command. The task's live responsible
planner, resolved the way project-addressed messages resolve (not only the
stored `project.planner.agentId`; Tom, 2026-11-19, no singleton planners): every
command. The task's coordinator (its recovery run): every command except
accepting `hold_owner`, `route_policy` or `two_writers`, and except `merge.now`
and `closeout.now`. Workers and reviewers ask instead. A `critical` task: planner
and operator only.

## Normal flow keeps working, and stops being a lever

The normal-flow verbs keep their meaning for ordinary progress. Where agents
and Nucleus itself use them today as indirect levers, the explicit command
replaces the lever, and `next`, stop text and refusals name the explicit
command instead:

| Lever used today | Explicit command |
| --- | --- |
| `restart role=reviewer fresh` to get a new reviewer | `run.start reviewer fresh replacing=<run>` |
| `restart role=reviewer` to make the reviewer report | `message.send reviewer` or `run.start reviewer retained` |
| `move to=review` after a silent worker pushed | `run.start reviewer head=<sha>` |
| `move to=review` / `stop` to drop the integration turn | `turn.release` |
| `move to=merge` to re-claim the turn | `turn.take` or `merge.now head=<sha>` |
| forced `retry_effect` on a run or operation | `run.release` or `record.clear effect` |
| `route role=X now` on an uncertain creation | `run.start X fresh replacing=<run>` |
| restart to start a missing revision run | `run.start worker retained` |
| restart on a merged task | `closeout.now` |
| restart or a "Retry …" choice to answer an escalation | the explicit command, then `record.clear escalation` |
| forced `move` as a universal reset | the named `run.release`, `record.clear`, `phase.set` steps |
| Nucleus's own responsible-fault fresh-then-retained fallback | `run.start reviewer` with an explicit agent choice |

## Fixes underneath

These make the commands safe and the stalls visible to someone who can act:

1. **Typed fields, not prose.** Every decision that reads `stop.detail` or
   `task.reason` text reads a typed field instead, so an explicit clear cannot
   silently change what happens next.
2. **A coordinator is asked about every mechanical stall.** A stop or wait that
   no fact will clear on its own within its window launches the task's
   coordinator with the explicit commands available, instead of sitting as a
   "waiting" stop no role sees. The existing loop breaker stays.
3. **Escalations follow the task, not a snapshot.** An answer binds to the task
   version, not a binding hash; it may carry an explicit command; and an
   escalation closes itself when its cause clears.
4. **A prerequisite wait gives up the integration turn**, as any non-verifying
   state does.
5. **One slow call does not mark a host down.** Host availability comes from the
   host's own health reading; a single call timeout affects only that call's
   task.

## What changes in earlier specs

- Spec 050 gains the explicit command set as a section beside the owner verbs;
  "owners can always get past a failed gate" becomes literal.
- Spec 066's rules "a force decision supplies no missing fact", "an unknown
  response never authorizes a resend" and "exact lookup is the only exit" are
  withdrawn. An unknown response is a warning the caller accepts; it never
  causes a blind automatic resend by the scheduler.
- The proof owners (exact creation lookup, pre-send receipts, owned-tool process
  proof, archive proof) stop being gates. Where a fact is still useful it is
  shown as a warning's evidence.

## What gets deleted

From the audit's measurements (current sizes), once the commands and fixes land:

- Removed outright, about 7.2k lines: `core/recovery/absent-creation/**`
  (1,335); pre-send receipts (`store-pre-send`, `operation-receipts`,
  `enclosing-operation`, 602); the per-effect settlement modules
  (`effect-reconcile`, `effect-gates`, `retry-evidence`, `retry-routes`,
  `non-delivery`, `refused-launch`, `retired-observation`, `live-noop`,
  `host-read-transient`, `merge-occurrence` and neighbours, about 2,470);
  `restart-episode` and the `retry_effect` replay variants (1,036);
  `owned-tool` and its process proof (1,233, replaced by killing the recorded
  process group in `run.release`); `archive-proof` and `archive-reconcile` (557).
- Shrunk, about 8k lines: `verb-fences` to a warning builder; `recovery-effects`
  to a read-only list; `fence-settlement`; escalation settlement without
  binding refusals; coordinator episode, route, pass and settlement without
  witnesses or derived-incident proofs; `transient-resume` and `observation`;
  creation and liveness gates inside `route`, `owner-restart`,
  `restart-worker`, `reviewer-report`.
- The tests that pin proof states go with their modules.

Kept as real protections: exact-head review or recorded operator acceptance
before merge, the guarded merge at GitHub, per-run callback credentials revoked
on release, never removing a worktree with uncommitted changes, the retained
reviewer and recovery thread, the coordinator loop breaker, and holds placed by
an owner (overridable only by planner or operator).

## Batches

Each batch is one review and roll. New code stays within three production
modules and about 1,500 changed lines; deletion of superseded modules rides in
the same batch and is not capped, so a removed path can never coexist with its
replacement.

| Order | Change | Deletes in the same batch |
| --- | --- | --- |
| 1 | Typed fields for every prose-matched decision. The command contract (warnings, `accept`, `owner_resolution` event, version-only check) and authority by live responsible planner. `run.release` and `record.clear`, settling the underlying fact. | `retry_effect force` settle-only path; force's stored-planner match |
| 2 | `run.start`, `phase.set`, `message.send`. `next`, stop text and refusals name the explicit command. Coordinators launch for mechanical stalls. | `core/recovery/absent-creation/**`, creation gates in `route`/`restart`/`reviewer-report`, responsible-fault fallback |
| 3 | `turn.take`/`turn.release`, `merge.now`, `closeout.now`. Prerequisite wait releases the turn. | `merge-occurrence`, restart-to-closeout path, turn-lever refusals (supersedes nucleus#1513) |
| 4 | Escalations bound to version, carrying explicit commands, closing when the cause clears. | escalation binding-hash refusals in `escalation-settlement` |
| 5 | Host availability from health readings, not one call. | host-wide timeout stamping |
| 6 | Proof owners out of the gate path. | pre-send receipts, owned-tool proof, archive proof, per-effect settlement modules, `restart-episode`, `retry_effect` replay variants; shrink `verb-fences`, `recovery-effects`, `fence-settlement`, coordinator episode modules |

Acceptance for every batch: today's cases resolve in one explicit step each —
praxis#369 and underlay#046 (`run.start reviewer fresh replacing=…`), oxide
(`turn.release`), #1491 (`record.clear escalation` and `effect`), #1508
(`run.start reviewer head=…`), #1498 (`run.start worker retained`) — with real
stored shapes, and each command's warnings appear and are honoured only when
accepted. Normal-flow behaviour is unchanged.
