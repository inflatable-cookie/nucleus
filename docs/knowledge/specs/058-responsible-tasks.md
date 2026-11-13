# 058 — Responsible tasks

Status: approved (Tom, 2026-11-02: "Go for it"); slices 1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18 and 19 installed, rollout step 3 installed (worker-to-worker messages, task 621, 2026-11-03), rollout step 4 installed (cutover batches 1–7, 2026-11-02)
Owner: Nucleus runtime maintainers
Created: 2026-11-02
Decision: [vision — Responsible tasks](../vision.md#responsible-tasks)
Governing refs: [Spec 057](057-retained-change-review.md) (retained reviewer),
[Spec 050](050-owner-task-controls.md) (owner verbs, to be narrowed),
[vision — rename to Nucleus](../vision.md#queue-becomes-nucleus).

## Problem

Nucleus closes a lot of PRs but costs too much to run. In the 24 hours to 2026-11-01, 1,876 agent
runs finished 30 tasks; 1,075 of those runs were coordinators. Authority sits with planning and
owner threads, not the worker, so keeping work moving needs a chain of Chatterboxes, Supervisors
and per-task coordinators relaying messages. Larger tasks fall into review loops and escalation
cycles, and the ceremony a worker must navigate makes tasks brittle.

## Model

A task on the board is a unit of work one thread is responsible for.

| Role | Responsibility |
| --- | --- |
| Operator | Priorities, answers to questions, acceptance |
| Planner (one, optional) | Plans with the operator and puts tasks on the board. A worker returns to it only when the brief is unclear. If the operator keeps it, it may coordinate a large chain of dependent tasks as the one controlling thread (Tom, 2026-11-02) |
| Worker | Owns the task end to end in its own worktree: approach, subagents, PR. Decides within the brief; remaining questions go to the retained reviewer first and planning rulings climb the ladder (Slice 17); may message other workers |
| Reviewer (one per PR, retained) | Reviews only what changed since its last review (Spec 057), works directly with the worker, approves when it is right |
| Recovery (rare, one, retained) | Only for system faults: usage exhausted, agent crashed, effect broken. Does what it needs to get going; escalates only when truly stuck |

There are no owner threads, Chatterbox or Supervisor routing hubs, or per-task coordinators.

### Lifecycle

1. **Board.** A task is planned (planner) or **registered** by any thread (`task.register`): the
   thread that registers becomes the worker, bound to its own worktree. Both paths then follow the
   same lifecycle.
2. **Work.** Nucleus provisions the worktree and model (capacity, admission, failover). The worker
   does the work, using subagents as it sees fit, and opens the PR.
3. **Review.** Nucleus assigns one reviewer for the PR's life. Reviewer and worker talk directly:
   findings, fixes, a delta re-review, until the reviewer approves.
4. **Merge.** Reviewer approval at the exact head plus passing checks merges. No merge hold by
   default (see Holds).
5. **Closeout.** Nucleus merges, syncs, cleans up and records the outcome.

An approved report-only brief (`queue.reportOnly: true`) follows a no-PR delivery:
the worker writes to its Nucleus lane document and returns `report_ready` with the
exact `{key, version, digest}`. Nucleus releases the run and parks the task in
`report_ready`, notifying the project planner or Nucleus planner. The planner uses
Spec 050 `complete` with that artifact, or returns the task with `move to=work`
and an instruction. This is a delivery state, not a blocker: it starts no
reviewer consult, recovery coordinator or escalation ladder. Ordinary tasks
cannot report `report_ready`. A lead-promoted report-only brief is read the same
way as a submitted one; see [Spec 050](050-owner-task-controls.md#report-only-delivery).

### Questions and budgets

- A worker or reviewer asks in-turn, on every provider, with `ask` (alias `nucleus_ask`) on the
  run's own MCP binding (task 550; task 1108 renamed the verb and its recipients). Its optional kind is a hint: worker and reviewer questions,
  including native questions Nucleus intercepts, follow Slice 17: a worker consults its retained
  reviewer first unless the question is operator-only. A named recipient addresses its own rung (task 1108):
  `to: "planner"` starts on this task's planner ladder without the reviewer rung, `to: "reviewer"` or no
  recipient keeps the reviewer-first rung, and project or other-task routes ask those ladders directly.
  Reviewer asks skip self-consult and take the
  same planner or decider classification as worker asks. An ask with no real question (empty or the
  literal `placeholder`) is refused back to the agent and never routes. Planning rulings go to the planner (or decider)
  for classification before any operator decision. Only an explicit `Decision: operator` reply with a one-line reason
  forwards it; an unanswered or unobserved delegate reply does not. Where the provider has a
  native Paseo agent question (Codex only today), the thread is highlighted in the sidebar and answerable there; Nucleus mirrors the open
  question on the task (board card, composer pill); answering in either place resolves both, because
  the pill answers through the same native question (Tom, 2026-11-02: "get the best of both"). A
  provider without a native question surface (pi workers: GLM, Deepseek) receives Nucleus-raised
  questions by a prompt to call `northstar_ask` with the exact question content, and the answer
  returns in turn through the tool; Nucleus-raised questions join the same path by their content.
  Decisions Nucleus originates (budget pause, the three-round check) are raised by prompting the task's
  own thread; the #584 escalation ladder sends non-converging review questions
  to the planner. Paseo 0.14 exposes open questions as agent pending permissions of kind
  `question`; the plugin can observe agent snapshots and answer with `respondToPermission`, using
  the question headers as keys in `updatedInput.answers`. The Codex daemon maps its async questions
  into that surface. Nucleus raises a question by prompting the task thread to ask it; an active
  timeline subscription receives the matching permission-resolution event and its answer. The
  caller records the send intent first; interrupted observation leaves the outcome unknown and
  is not permission to resend.
- Each task has a visible budget, a safety net rather than something to tune (Tom, 2026-11-02:
  "it will vary for every task"). Measure effective tokens across worker, reviewer and subagents
  (uncached input + output + 10% of cached input) and wall time. Default by complexity, provisional
  until a short shadow period sets each to about 1.5× the observed 75th percentile: low 2M / 1 h,
  medium 5M / 3 h, high 12M / 8 h, very_high 25M / 16 h. The planner sets it from complexity; a
  self-registered worker picks a size. Reaching it pauses the task with a pill: extend, change
  approach, or stop and keep the work.
- After 3 review rounds without convergence (Tom, 2026-11-02), worker and reviewer write one joint summary of the
  disagreement. The question enters the #584 ladder and goes to the planner; the worker model
  is never upgraded automatically.

### One reviewer per PR, no side readers (Tom, 2026-11-01)

"It looks like Project-f is bypassing the single dedicated reviewer setup!!" Every PR has exactly
one reviewer: the retained Nucleus reviewer. Planners and workers create no additional
"independent", "distinct" or "counted" reviewer, review-lens or native-reader agents, and no
separate workspaces or projects for them. A needed native proof runs once through the task's
`proof` route at the exact head and the retained reviewer judges it. Native qualification
beyond that is a release gate the project planner owns and may accept by delegated decision.
Briefs written before rollout that demand multiple readers are amended to this.

### Fewer questions, delegated answers (Tom, 2026-11-01)

"Ideally there wouldn't be a question at all - if the proofs are needed and can run, then they
should run. We need to minimise the number of questions [...] and we need a way for them to be
answered by an agent where possible so tasks don't get blocked overnight."

- A missing proof that Nucleus can execute (a selector, test or check at the task head) runs
  automatically through the `proof` route, and the reviewer judges the result. No question.
- Every remaining question has a kind. Only these stay the operator's: scope or product changes
  (changing what a task delivers, abandoning work), raised as a discussion rather than a yes/no
  question; releases and outward actions (publishing, production enablement, creating external
  resources); and frontier or above-ceiling profiles (board sign-off). Everything else is delegated,
  including accepting a head whose native, consumer or post-merge proofs haven't run, and spend
  past 2× a task's budget.
- **Approve by default (Tom, 2026-11-03).** "When the question is just approve something or to
  hold, I will always approve unless it's making a product change that I need more details on, and
  in those cases these questions aren't the right format, it usually needs a proper discussion. I
  need agents to be a bit more discerning in when to seek approval - binary yes or no decisions will
  almost always be yes otherwise progress just halts." Ruling on scope: approvals and spend are
  covered; releases and outward actions still come to the operator. So a binary approve-or-hold
  question (including a budget extension past 2×) isn't asked of the operator: the agent proceeds,
  or the planner or decider answers "approve" and records why. A product or scope change goes to the
  operator as a discussion with the context, options and a recommendation, never as a bare yes/no.
- A remaining worker question goes to its retained reviewer first (Slice 17). A planning ruling
  goes straight to an agent, day or night: the project's planner thread,
  or, if none is registered or it doesn't answer within about ten minutes, a short-lived
  decider agent given the task's brief, review and proofs. The answer goes through the same
  native question and records who decided and why. The operator sees it in the task's activity
  and can override it with the ordinary verbs.
- **One set of rules on every delegated route (Tom, 2026-11-06).** Tom's word on the three
  recommendations below was "Go". They hold for native questions, `nucleus_ask`, Nucleus-raised
  decisions, planner escalations and re-asks, and the task context also goes to reviewer consults:
  - **Missing planner.** Every route takes the planner rung from one lookup. "A project with no
    planner doesn't wait 10 minutes for nobody; it goes straight to the next rung of the ladder."
    The rung is the live project planner, then the live Nucleus planner, then a decider. An
    escalation also asks the task's live origin thread before the decider. An archived or missing
    thread counts as nobody; a closed one stays registered and is asked.
  - **Binary approval order.** "The same order everywhere: the operator's answer always wins over
    a delegate's, on every path. A delegate's 'Hold' stands as a hold and never becomes an
    approval." A delegate's `Decision: operator` reaches the operator even on a binary question,
    and an answer the operator already gave leaves the delegate's later one with no effect.
    Approve by default still tells a delegate to answer yes, and Nucleus records that authority
    when it does. Nucleus adds no default that overrides what a delegate said.
  - **Task context.** "Every delegated question carries the task context that Spec 058 promises, on
    every route." The prompt carries the task's title, stop, head, brief, latest review and
    awaited proofs, one indented line per fact, 12,000 characters at most.

### Shared delegation and uncertain delivery

Planner-then-decider questions share one durable routing path across in-turn asks,
Nucleus-raised decisions, native questions and planner escalations. It records
intent before delivery and uses one reply parser; AgentAsks and Ladder own their
respective resume logic.

A Nucleus-raised question whose native delivery goes unknown still reaches the
planner ladder. The same question id is delegated to the task's planner rungs,
whose `question.answer` settles it, so a short transport drop no longer strands
a task that was ready to continue (papercut a1bc9fe5). A late native answer
reconciles with that same question and applies no second answer or control;
the recorded answer remains the question's one outcome.

After unknown planner delivery, Nucleus never asks the decider or resends the
question. The question stays pending through the bounded in-turn wait and is
reported as uncertain for the planner (planner ruling, 2026-11-09). A known unanswered planner
window may advance to the decider only when the journal also records that the
host send completed. A send intent without that observation remains uncertain
after restart; an authenticated answer can still settle its original window.

Delegated budget extensions carry the structured
`budgetAuthority: "approve_by_default"` field. Free-text notes record the reason
but grant no budget authority. Agent prompts retain instructions for judgment and
question content; code owns routing and force gates.

### Holds

A merge hold exists only when another thread needs it for a stated reason (for example, a dependent
task or an owner-gated proof). That thread places it, coordinates with the worker or reviewer about
it, and releases it. There is no default hold.

### Recovery

Mechanical faults are handled by code where possible: a model out of usage is switched to one with
capacity; a crashed agent is restarted on the same task. Only when code cannot settle the fault does
one retained recovery thread take over, with the authority to do what is needed. It escalates to the
operator only when genuinely stuck.

A recovery episode that records `recovery_pending` and then starts no run reaches people anyway: a
pending episode with no run, no accepted action and no paused or dispatch-held wait escalates to the
task's planner ladder after three minutes, naming the stop and the verbs that exit it (papercut
0489ea25: nucleus#1166 sat pending for 2h14m because the stalled run still held its lease and no
launch, wait or escalation followed). A legitimate capacity, dispatch, route or environment wait
clears the pending episode instead, so it is not escalated by this bound.

### Capacity counts live agents (Tom, 2026-11-03)

A task occupies a global or project slot only while one of its agents is actually running: a worker,
revision, reviewer, executor, recovery or closeout coordinator turn (an unreleased run with a live or
starting agent, or dispatch creating its workspace ahead of the launch). A task with no running agent
that is only waiting on hosted checks, the repository's one-at-a-time integration (merge) turn,
mechanical verification, a thread release or settlement holds no slot. It keeps its place in the merge
order, and when it next needs an agent — review after CI, a revision after a refusal, closeout — it
requests a slot through the ordinary fair-share order. Capacity waits and the board's slot counts report
agents in use and list slot-free waiters separately, so the blocking work and the waiting work stay
visible. The merge order lives in the integration turn and its lease, which are separate from slots.

### New starts are capped by tasks in flight (Tom, 2026-11-04)

Slots bound live agents, not worktrees, so a project whose tasks sat between review states kept starting
new tasks: Project-a had 25 in flight with 5 live agents at a limit of 6, and every worktree adds polling and
disk load on the external work volume. Tom chose a separate cap over counting tasks in slots ("A"). A project's
in-flight cap is always twice its effective project slot limit, and follows every change to that limit.
There is no separate in-flight override (Tom, 2026-11-08: "it should just always be double the number of
slots"); a value an older build stored is ignored. Nucleus counts every
nonterminal task with a Nucleus-owned workspace or workspace-creation intent, in any phase, including
parked, held and needs-attention tasks. Adopted workspaces and review-entry tasks that preserve an
external workspace do not count. Intake-owned review-entry workspaces count once bound, but first
admission creates no workspace and does not enter the creation gate. Proof-only tasks count when Nucleus
owns their workspace. The board shows
both live-agent slots and in-flight worktrees per project.

The cap gates only the first dispatch that creates a Nucleus-owned workspace. At or above the cap, the
queued task waits with its in-flight count and takes no slot; it does not reserve capacity from another
project. Already-dispatched tasks continue through reviewer, revision, executor, recovery, merge and
closeout turns even while the project is over the cap. Existing work is not stopped when the count is
already above the cap; new starts resume after it drains below the cap. Slot counting and fair-share order
are unchanged.

## Installed

### Slice 2 — every task is responsible (tasks 512, 534; cutover 1, 2026-11-02)

- **No opt-out.** Every new task runs the responsible lifecycle. An absent `queue.responsible`
  (or `responsible` on a direct submission) means true; an explicit false is refused at
  submission and `amend_brief`. The optional persisted field remains readable for old rows,
  and the pre-rollout `submissionHash` / `legacySubmissionHash` identities stay frozen.
  A broken lifecycle is repaired through a direct PR with operator source acceptance.
  `manualVerification` cannot create an old-lifecycle task.
- **Fixed at creation.** New tasks are responsible from creation; historical rows keep their
  recorded field for readability and identity. There is no conversion path.

- **No coordinator for routine work.** Reviewer approval at the exact head plus the
  existing Nucleus-owned mechanical merge gates (`mechanicalVerification`) merges. No
  verification or closeout coordinator is created by the ordinary path, and there is
  no default merge hold; a hold exists only when another thread places one with a
  reason (Spec 040), exactly as before.
- **Direct exchange.** The retained reviewer (Spec 057) works with the worker through
  the ordinary review rounds: a `changes_required` verdict is the worker's next
  revision instruction and the worker's returned head is the reviewer's next
  exact-head turn. No coordinator relays either direction. Worker-initiated
  worker-to-worker messages were rollout step 3; they are installed as Slice 18
  (`northstar_message`, task 621).
- **Authenticated readiness refusals return to the responsible worker.** A
  `ready_for_review` report whose PR is closed, draft, or on the wrong branch or
  base, or whose checkout fails cleanliness or branch verification, is returned
  as an authenticated worker revision with the exact refusal reason and repair
  instruction. Nucleus records the refusal on the task and shows it in `next`; an
  authenticated PR report remains visible to recovery and planning. The worker
  reports again on the same PR after a checkout repair, or reports a replacement
  PR after an identity repair. This creates no recovery run and does not weaken
  callback authentication. Other tasks keep the existing recovery path.
- **OS metadata is not task source.** Shared checkout cleanliness checks ignore
  untracked `.DS_Store`, `.localized` and `._*` AppleDouble files, including in
  review and closeout proofs. Nucleus preserves these files and never removes them.
- **Owner review moves clear obsolete stops.** When an owner `move to=review`
  starts a reviewer, it clears stale recovery or operator-needed stop text so the
  active review is the task's current instruction.
- **Mechanical faults by code.** A worker model whose provider reports quota
  exhaustion is already routed to an eligible model on the same workspace by the
  ordinary failover sweep. For a task, a reviewer that stopped without a
  verdict (its agent observed closed, or no callback and no checkpoint continuation)
  is replaced by code through the ordinary `restart role=reviewer fresh` path at the
  same head — once per stopped head. A repeat at the same head is a fault code cannot
  settle and opens exactly one retained recovery run, as does any other fault.
- **One joint question.** After the third substantive `changes_required` review
  without convergence, Nucleus sends the task's own thread one prompt to raise a single
  native Paseo question for the planner ladder (Spec 058 questions; `raiseNativeDecision`) carrying the
  reviewer's authenticated full finding and the worker's last return, and records the
  durable send intent first. The planner may choose a different worker model with
  `route role=worker`; Nucleus does not upgrade it automatically. The task
  waits in the `responsible_question` stop, which clears when the answer arrives; a
  lost observation is recorded as unknown and is never resent.

### Slice 4 — `task.register` (task 513)

- **Any thread registers itself.** `task.register` records a task whose worker
  is the calling thread, bound to the worktree it is already in, with a title,
  a short description and a complexity size for its budget. The task is always
  responsible; no planner, owner or coordinator role is created. Afterwards it
  follows the same lifecycle as a planned task: PR, retained reviewer, merge,
  closeout, usage and operator questions.
- **Identity from the thread, never a typed name.** The input carries no agent,
  workspace or branch field, so the binding cannot be steered from input. The
  CLI overwrites `caller` from the calling thread’s Nucleus ticket or host identity and the service binds the task
  to that thread's own live Paseo worktree. The Paseo bridge path, whose
  envelope carries no reliable caller identity, is refused, as is a caller that
  is not a live Paseo thread.
- **Clean separate worktree only.** The worktree must be an isolated worktree
  root on a branch of a registered repository, off the integration branch.
  Registration from the registered checkout, a detached head, a dirty tree, a
  foreign repository, or a workspace, agent or branch already on the board is
  refused with the reason; nothing is reset, cleaned or rewritten to obtain it.
  Concurrent registrations serialize on one write transaction around the final
  ownership recheck and the insert, so one worker and worktree are claimed
  exactly once.
- **Skill documentation deferred.** Registered tasks appear on the board as
  ordinary working tasks, but the method is not in the nucleus skill
  yet: that entry waits on a warning to Northstar planning before any
  skill-documented method change.

### Slice 5 — operator-only waits ask on the task's own thread (task 523)

- **Which waits ask.** A responsible task parked on a wait only a person can clear
  asks the operator on its **own** thread, through the same mechanism as the joint
  review question (`raiseNativeDecision`, one native Paseo question answerable in
  the sidebar or as the task's composer pill). Two shapes are in scope:
  - a source approval parked in `awaiting_proof` (the reviewer approved the exact
    head and named proofs Nucleus cannot run by itself; Queue #520 showed the wait
    could sit for half an hour with the notice only on the origin thread); and
  - a `blocked`, `error` or `needs_attention` stop on a responsible task whose
    `next` offers no mechanical verb Nucleus can run — `restart`, `move`,
    `retry_effect` and `proof` all refuse. `route` (which profile) and `complete`
    (end the task) are the operator's own dispositions, not a mechanical path, and
    the question names them instead of applying one.
- **Which waits never ask.** A task without `responsible` keeps today's notices
  exactly. A wait the code or the task's own threads settle raises nothing:
  capacity, required checks, a running reviewer or any unreleased run, a
  provider, route, prerequisite or workspace wait, the joint review question
  (`responsible_question`), and a hold, which has its own owner reminders
  (Spec 040). A paused Nucleus asks nothing.
- **One question per stop and head.** For `awaiting_proof` the head and the
  proofs it asks about identify the question, not the stop episode (Slice 9). The durable send intent
  (`operator_question`) is written before the thread is prompted, so at most one
  question exists per recorded stop episode and PR head, and at most one is open
  per task. An interrupted observation is recorded as
  `operator_question_unknown` and is **never** resent; the answer arrives as
  `operator_question_answered`.
- **The question carries the decision.** It names the stop's reason and detail
  and the exact choices that apply. For `awaiting_proof` those are: merge now
  without the named proofs (`move to=merge` at that head with an operator source
  acceptance; the option reads "Merge now without these proofs (run them after
  merge)", and the body says the proofs will not run before the merge), run the
  proof (only when the brief names an unspent author-side execution), return the
  task to the worker (`move to=work`, see Slice 9), and leave it held for the
  planner (a merge hold with the proof list as its reason, see Slice 9).
- **The answer applies through existing verbs.** Nucleus applies the chosen verb
  with the ordinary owner controls, so the acceptance, the proof activation and
  the source identity are the ones those paths already prove. The authority
  recorded is the answer itself, relayed by the task's own thread that asked; no
  new authority kind, guard or exception-specific control is introduced. A
  free-text ruling (the shape with no applicable verb) is recorded for that
  thread and applies no invented control.

### Slice 7 — conversion is removed (cutover 1, 2026-11-02)

The task conversion control, native conversion question, conversion markers and batch
`queue.responsible-convert` RPC are retired. There is no in-Nucleus escape from a broken
lifecycle; use a direct PR with operator source acceptance. Historical task rows with
`responsible: false` still parse, and historical hashes remain unchanged.

### Slice 6 — budget pauses (task 526)

- **Measured and enforced per responsible task.** Effective tokens (uncached input +
  output + 10% of cached input) sum over every run since the task became responsible,
  workers, reviewers and recovery alike. Wall time starts at the later of a historical
  conversion and the first run in the responsible lifecycle. Older converted tasks
  retain their `responsible_converted` event timestamp; new tasks need no conversion
  record and use the first-dispatch clock. The
  size sets the limits: low 2M / 1 h, medium 5M / 3 h, high 12M / 8 h, very_high
  25M / 16 h, provisional. A `very_low` task takes low; a responsible task with no size
  takes medium. The defaults are constants in `shared/task-budget.ts`; there is no
  tuning UI.
- **Pause, not kill.** The launch funnel refuses every new run once either limit is
  reached, so a run in flight finishes and nothing new starts. The task stops with
  `budget` as its stop reason and the detail names the limit. That detail is fixed for
  the pause, so waiting does not rewrite the stop.
- **Always asks, always names its exit** (nucleus#1153). The pause asks its question
  from the task's own pass, in every phase, as well as from the sweep's question step,
  and the stop lists `extend_budget` in `suggestedVerbs` whatever the phase. A task
  host that is offline (or a run carrying another host's identity) never silences it:
  the question is recorded on the board instead, with the reason it is not on the
  thread. Two T3 tasks sat 90 minutes at `awaiting_review` with `Budget reached`,
  empty `suggestedVerbs` and no question at all.
- **One question per pause.** The pause raises the same native operator question as
  the stops above, on the task's own thread, with the used and limit figures. The
  durable intent is the fence, so an interrupted observation is `operator_question_unknown`
  and is never resent. Only one open question per task.
- **Wall time is the task's own work** (nucleus#1153). Each task quantum settles a
  durable pause interval (`resolution.budgetClock`) while the task waits on a
  Nucleus-side cause: a recorded `external_unavailable`, `workspace_unavailable`,
  `route_unavailable` or `provider_unavailable` stop (a host-adapter refusal before a
  send, a missing workspace, no runnable profile, a provider outage), an unresolved
  `workspace_state` or `uncertain_delivery` incident, a proven pre-send refusal that
  parked the task in attention (`worker_creation_refused_before_send` and the
  reviewer-launch equivalents, held until an owner resume resolves the episode), a
  dispatch hold, or a sweep `observation_outage` on its lane. An outage pause opens on
  the first observation, while the lane is still wedged, is dated from that
  observation, and only that quantum's own return closes it — so a return that beats
  every sweep visit still books the whole outage. The interval closes when the task can make progress again, and its
  time is subtracted from the wall figure. The paused
  total is reported as `wallMs.pausedMs` on the detail and named on the budget's time
  bar, and the transitions are durable `budget_clock_paused` / `budget_clock_resumed`
  events. A budget pause, a merge hold, capacity queueing and the task's own
  validation keep charging: they are the task's work or its own answer to give.
  The clock is a Queue-owned record like runtime retirements: opening or closing an
  interval spends no task version, so a sweep or quantum never makes an owner's
  control sent at the version it read stale (milestone QA 54d51476).
- **Holds.** A dispatch hold suppresses the question because it blocks runs. A merge
  hold does not: it does not block runs and cannot leave a budget pause without an
  answer.
- **Answers.** `Extend the budget` adds one default increment to both limits and lifts
  the pause. `Change the approach` adds the same increment and sends the answerer's
  recorded direction to the worker as its next instruction (`move to=work`), retaining
  operator, planner or decider attribution. `Stop and keep the
  work` applies the owner `stop` verb: live work halts, the branch and PR stay, and the
  task is parked under a dispatch hold. A free-text answer is recorded and applies
  nothing. A late answer to a superseded budget question has no effect. Whenever
  either task budget limit is exhausted, `next` offers `extend_budget`, whatever the
  current stop; it applies the same one-increment path and preserves non-budget stops.
  Only the board operator or an authenticated relay carrying the operator's
  authorization note may use it.
- **Owner controls supersede open questions.** Once an owner control applies, any
  unanswered Nucleus-raised native or delegated question about the prior task state is
  marked superseded and its linked board decision is withdrawn. A later answer is
  retained as stale-answer history and cannot change the task or its continuation.
- **Unknown usage.** A run with no usage record adds no tokens, and the card reports
  the token figure as not reported rather than zero. Such a run never pauses the task on
  tokens; wall time still does. Partial usage is a lower bound, so reaching the limit on
  it is a real pause.
- **Board and detail.** The card and task detail show `used / limit` for tokens and time
  for a responsible task that is not finished, and the card names the limit reached.
  Old-lifecycle tasks get no budget.

### Slice 8 — a named proof goes to whoever can produce it (task 533)

- **The tag selects only the route.** A reviewer that approves the source but
  cannot complete names each missing proof with the route that can produce it:
  `awaitingProofs: [{proof, route}]`, where `route` is `author`, `environment`
  or `external`. A bare string is still accepted and gets one author round at its
  head before it can reach the operator (Slice 9). The tag never publishes a
  review, grants approval or replaces the reviewer's judgment at the head.
- **Author-producible evidence returns to the author.** An `author`-tagged proof
  (the brief's own tests, selectors or execution evidence at the head) returns the
  task to its retained worker with the reviewer's proof list as its instruction,
  and names the exact head. It is an administrative revision: it consumes no
  semantic review round, and the later evidence-only review at the same head is
  the reviewer's ordinary next turn, with the same retained reviewer.
- **An environment fault gets one clean retry.** An `environment`-tagged proof —
  a check that failed before any assertion in the reviewer's own run, such as tsx
  IPC `EADDRINUSE` or a missing temporary directory — is not evidence about the
  source. Nucleus dispatches one reviewer turn at the same head, once per head,
  instructing a fresh temporary directory under the configured scratch root as
  `TMPDIR`. The retry intent is recorded on the task and consumed onto that run,
  so a second dispatch at the same head is impossible. A second environment fault
  for the same head is `external`: it parks and asks.
- **Only external proofs reach the operator question.** Native hardware, another
  project's consumer verification and post-merge proofs are `external`; only these
  park the `awaiting_proof` wait, and the parking record names just them (a spent
  environment fault is stored as `external`), so the Spec 058 slice 5 question and
  its #531 wording apply to the operator's own gate and nothing else.
### Slice 9 — a proof question never loops (task 539)

- **Return to the worker carries the work.** The "Return the task to the worker"
  answer (`move to=work`) sends the reviewer's awaiting-proof list at the head as
  the worker's instruction: produce each proof it can at that head (exact command,
  head, observed result) and say plainly which it cannot and why. The operator's
  answer follows it.
- **A proof the worker already had is not offered back.** Each proof Nucleus sends to
  the worker at a head is recorded (`proof_worker_requested`). Return is offered
  only while some asked proof at that head has not been sent to the worker. A
  question names that, and the body says so when Return is withheld.
- **No repeat at the same head.** The `awaiting_proof` question is identified by
  its head and the external proofs it asks about. A worker round that reports
  blocked re-records the wait as a new stop episode; the same head and proofs do
  not raise the question again. The record stays on the board for the operator's
  owner verbs.
- **An untagged proof gets one author round first.** A bare proof string is routed
  `author` at its head before it can reach the operator. The worker round is
  recorded; if the reviewer names the same proof again at that head it is
  `external`, parks, and asks. Changing the head starts a new round.
- **An author-tagged proof named again at the same head is `external` too.** The
  author round covers it once per head, so a repeat never loops back to the worker.
- **Leave held for the planner.** A third choice on the `awaiting_proof` question,
  offered whenever an external proof asks: `hold kind=merge` with the proof list as
  its reason. The question closes because a merge hold is the owner's gate and
  Nucleus raises no question under one. The planner or operator runs the proofs
  through the `proof` verb, then accepts the head or releases the merge hold. The
  dispatch fence and the reviewer record are untouched.
- **A missing planner does not strand delegated work.** Nucleus checks the registered
  project planner before routing. A missing or archived thread is cleared from the
  project, the Nucleus planner receives delegated questions, and the board labels the
  project planner as missing. Nucleus notifies the Nucleus planner once for that
  missing-planner episode. A closed thread stays registered and still receives the
  question; if it gives no usable answer in time, the existing decider fallback
  applies. A decider cannot answer "Leave held for the planner" after that planner
  failed; the question remains with the Nucleus planner for classification. When a
  live project planner is registered, each proof question parked under a merge hold
  is re-asked once to that planner.
- **Old brief gates are the planner's, not the PR's.** The reviewer prompt for a
  responsible task says that brief text demanding owner-activated native runs,
  counted diagnostics or checkpoint receipts describes release gates for the
  planner. The reviewer lists them as follow-ups and does not put them in
  `awaitingProofs`, unless one tests this PR's own correctness, the author can run
  it at the head, and it is tagged `author`. When source review passes and only
  those gates remain, the reviewer reports `ready_to_merge` at the exact head with
  the gates as follow-ups; the task's merge hold (if any) keeps it from merging
  until the owner releases it. The awaiting-proof path is for proofs of this PR's
  own correctness only.

### Slice 11 — runnable proofs run, and an agent answers every question that isn't the operator's (task 540)

- **Every Nucleus-raised question has a kind.** `OperatorQuestionKind` covers `proof_acceptance`,
  `budget`, `review` (the three-round question), `process` (a stranded stop), `scope` (a delivery change)
  and `release` (reserved). Only `scope` and `release` are operator-only. All budget
  pauses, including past 2x, use the delegated `budget` path; a worker's `northstar_ask`
  kind is only a hint and always goes to a delegate first.
  The legacy `spend` kind was also delegated and is retired (2026-11-06).
- **Runnable proof runs.** A source approval whose awaited proof is the brief's own
  declared `proofExecution` selector, while the one allowance is unspent, starts the
  existing executor at the approved head through the `proof` route. It records
  `delegated` authority with the note "Nucleus ran ...", is raised for no question, and
  starts once per head. The retained reviewer judges the evidence on its next turn
  through the Spec 055 settle path. A reviewer-named selector the brief does not
  declare keeps its ordinary route: a single allowance per task and the rule that
  Nucleus never grants execution from a document both stand against widening it here.
  Automatic dispatch requires the reviewer's latest verdict at that head to be a
  source-approved proof wait. A pre-selector refusal remains in history but
  frees its head for input re-declaration and one replacement activation; a
  started selector still reserves the head. After an earlier execution, an
  automatic run at a new head requires either a re-declaration for that head
  or proof that the declared input files have not changed since the last
  executed head. Otherwise Nucleus records `proof_autorun_waiting_inputs` and
  waits for the planner's re-declaration. With unchanged selector and hashes,
  an empty or documentation-only (`*.md` or `docs/**`) diff still records
  `proof_autorun_skipped` and routes the earlier receipt for reviewer judgment,
  or back to the worker when it failed. An explicit owner `proof` activation
  can still run at that head.
- **Delegated answers.** After the retained reviewer identifies a planning ruling (Slice 17),
  a delegable question goes to the project's **planner**
  (`project.set-planner`, which grants only its existing delegated-answer authority;
  [Spec 060](060-named-project-agents.md) owns the named-agent registry and the fallback).
  The planner receives the question only while idle; its busy time counts toward the
  ten-minute answer window. With no answer in that window, a short-lived **decider**
  answers once in the task's workspace on automatic selection, then is archived.
  Every route uses the [answer command](#delegated-answer-command), including
  reviewer consults and planner escalations. Chat output never answers a question.
  The answer resolves the same native question (`respondToPermission`), so the
  sidebar and pill clear. A send whose outcome is unknown is never repeated.
- **Recorded and applied.** The decision is recorded before the native question is
  answered: `Decided by planner|decider: <choice> — <reason>`, with the answering agent.
  It applies through the ordinary verbs with `delegated` authority (a new authority
  role on owner acceptances, proof activations and the controls that record them),
  never `operator (board)`. The operator can still override with the ordinary verbs.
  A lost delegate observation is `operator_question_delegation_unknown`: nothing
  re-asks and nothing re-decides, and the native question stays with the operator.
- **Not installed in this slice.** Undeclared runnable selectors still park; a
  rule that lets Nucleus run a reviewer-named test or check (single allowance and the
  execution-authority rule in `AGENTS.md`) needs a ruling first.

### Delegated answer command

Tom, 2026-11-05: delegated answers use `nucleus question.answer`, bound to the
calling thread by the same identity route as owner verbs. Its payload names
`questionId`, `answer` or `choice`, a one-line `reason`, and optional `overtakes`
with exact decision IDs; `decision: "operator"` classifies an operator-only
question without answering it. A repeated answer returns the recorded answer.
This changes no authority: operator-only questions retain their existing surfaces,
and applied delegated answers remain `delegated`.

A single short message names the task, question, choices and exact command, and
instructs the recipient to run it and write nothing else in the thread. Standing
rules live in the Nucleus skill. The command in the message teaches existing live
threads without a restart or skill reread. Nucleus never reads `lastMessage`,
matches an `Ask:` line or re-presents a chat reply to obtain an answer.

The Paseo adapter checks that the planner is idle with no pending permission twice
before sending questions and notices as agent messages. The sender is the asking
or reporting thread, the task worker, or the fixed `nucleus` fallback. Source grants
no authority. Paseo may clear a permission that arrives in the roughly two-second
queue window after the final check; the planner accepted this limit on 2026-11-05.
Busy time consumes the existing answer window.

### Slice 10 — the task detail reads in ten seconds (task 538)

- **A summary, then depth.** The task detail leads with number, title, phase, project, PR and
  elapsed time, then one plain sentence for the current stop or wait with who is acting, one row
  per hold (holder, reason, age), the review round against its allowance with the latest verdict,
  the token and time bars, the latest check results as ticks, and the newest report's headline with
  its author, role and age. The full report sits behind **Read full**.
- **The question is answerable where the task is.** A task waiting on the operator shows the
  pending native question and its answer controls in the detail, beside the summary: the offered
  choices and a free-text answer. An answer there and an answer in the thread's question pill are
  the same native request, so Nucleus observes one resolution and neither place records a second
  decision.
- **Only the verbs that fit.** The two or three owner verbs `task.next` makes available for this
  state lead, and the rest sit behind **More**. A verb that does not apply is not offered; its
  refusal stays readable in the technical section.
- **Nothing is deleted.** Activity, Runs & agents and Technical are collapsed groups that hold every
  field the dialog showed before, and a responsible task does not render the old-lifecycle owner,
  coordinator and incident panels or the top-level Spec 053 demand table.
- **Reports carry a headline.** Every report has a headline of at most about 200 characters saying
  what happened and what is next. Nucleus derives it from the first sentence of the summary when a
  caller omits it, so every accepted report carries one, and a report stored before the field
  existed falls back to that sentence. A board card uses the headline as its snippet.

### Slice 11 — workers ask in-turn; an answered question resumes the task (task 542)

- **Ask in-turn.** For responsible tasks, the worker and reviewer prompts say: when a decision
  needs the operator, ask one native Paseo question inside the current turn, wait for the answer,
  and continue the work in the same run. Report `blocked` only if the task genuinely cannot proceed
  after the answer. The old-lifecycle wording that sends a blocked worker out for an owner decision
  ("needs an owner decision") is conditioned to the old lifecycle: a responsible blocked report
  stays parked for the operator-question sweep and the answered-question resumption, never an
  owner escalation.
- **An answered question resumes the task.** If a responsible task is stopped because its own
  worker (or reviewer) reported blocked, and that agent's native question is then answered on its
  thread, Nucleus continues the same retained agent with the answers through the ordinary `move
  to=work` (worker) or the retained reviewer restart. No owner or planner action is needed. It
  happens once per answered permission: the `worker_question_answered` / `reviewer_question_answered`
  event is the fence, and a lost observation is recorded as `*_unknown`, never resent. Observation
  uses the existing permission-resolution surface (`answeredQuestions`, read from the agent
  timeline via `agentTimelinePage`); a failed read is empty, never evidence. An answer read from
  an agent that is no longer the retained worker or reviewer is recorded as unknown and never
  applied to the new agent.
- **The task's own questions are delegated.** Nucleus observes pending native question permissions
  on the retained worker and reviewer of a responsible task. It sends their questions, the brief
  and latest review to the project planner, or to an automatically selected short-lived decider
  if no planner answers within ten minutes. The delegate answers through the original permission,
  keyed by question header; activity records the answer and reason. A delegate leaves product or scope changes, releases or outward actions, and frontier or
  above-ceiling profile requests for the operator as discussions, with context, options, a
  recommendation and the reason recorded. A delegate answers binary approve/hold questions approve
  by default unless they concern one of those operator matters; spending past twice the budget is
  delegated. Its `Decision: operator` or hold stands (Tom, 2026-11-06). A permission already answered
  on the thread keeps that answer. A durable intent fences
  each permission; unknown delivery is not retried. Nucleus-created marked decisions use their own
  delegation path. Workers and reviewers treat the retained reviewer as the independent review,
  can use in-session sub-agents, and settle process questions from the brief and repository;
  remaining worker questions go to the retained reviewer first (Slice 17).

### Slice 12 — any worker can ask, whatever its provider (task 550)

- **One ask tool on every provider.** `northstar_ask` rides the same per-run MCP binding as
  `northstar_report`: question, optional choices, optional kind hint (`scope`, `release` and `budget`
  are hints only; worker asks follow the reviewer-first route in Slice 17, including native
  questions Nucleus intercepts). The planner or decider may answer a planning ruling, or explicitly classify the ask as operator-only
  with a one-line reason. A timeout or unknown delivery stays pending without creating an operator
  decision. The tool is available to every Nucleus-launched worker and reviewer on every provider, so asking no longer
  depends on the provider having Paseo's native question tool. Worker and reviewer prompts name it
  as the way to ask; native questions still work on Codex but are never required.
- **In-turn, bounded, then pending with resume (task 562).** The call waits for the answer in
  the same turn for about 120 seconds; the planner window is about ten minutes, so the
  wait never covers delegation and never times out into unknown delivery. The result names
  the answer and who answered it — the operator, the planner, or a decider, with its agent.
  Past the wait the result is `Recorded as question <id>; pending with <planner|decider|Tom>`
  and the agent is resumed with the answer when it arrives; the worker may continue other
  work or end its turn, then call again with exactly the same question to collect the answer
  instead of asking anew. A transport failure is classified by its phase and never reads as
  unknown delivery: a connect failure, where the request never reached Nucleus (ENOENT or a
  dead-listener socket error during a roll), is a definite `not recorded, retry`; a response
  lost after Nucleus processed the ask says the recorded receipt is collectable; a call lost
  in flight points back to the identical re-ask without claiming the ask went unrecorded; and
  a call silent past the client's in-turn budget states no delivery verdict — whether the ask
  was recorded is unobserved — and sends the agent back to the identical re-ask, which joins
  the question if Nucleus recorded it or records it if not.
- **Routing as tasks 540, 573 and 723.** Remaining worker asks go to their retained reviewer
  first (Slice 17). Reviewer asks skip that self-consult and take the same planner or decider
  classification. An empty or literal `placeholder` question is refused to the asking agent
  before any record or route. Planning rulings go to the project planner, then to a short-lived decider
  after about ten minutes when needed. A worker's kind never
  routes directly to the operator: only an explicit planner or decider `Decision: operator` with a
  reason creates the board decision, which shows that reason and the recommended answer. A delegate
  timeout, unusable answer or unknown delivery does not classify the question for the operator.
  Nucleus-originated operator questions retain their own routing, including proof-only release GO,
  which remains directly on the board. The planner prompt (or decider start)
  is sent and the ask is visible in task activity even when the tool already returned pending.
  Proof-only release GO, the one operator-only kind Nucleus raises, is a Spec 032 decision linked to the task, shown on the
  board and the task's composer pill; the operator's answer settles the waiting call and resumes the agent.
  A delegate that classifies a question as the operator's escalates it the same way, with its
  reason recorded. Answers are recorded in activity with who answered, and the resume is recorded
  as `agent_ask_resumed`.
- **Record-before-send and the unknown rule hold.** The durable ask intent (identifying the
  question by its content digest) is written before any routing, and identical content is the same
  question: a retry joins the open ask and an answered one returns its recorded answer. A delegate
  answer that could not be observed is never re-asked to that delegate; the question remains pending
  without an operator decision unless a delegate explicitly classified it. A Nucleus-raised question
  whose own delivery was recorded unknown is never joined; the worker's ask routes on its own.
- **Nucleus-raised questions use the same path without native questions.** On a provider where
  `supportsNativeQuestions` is false (today every provider but Codex), the joint question, budget
  pause, proof and stranded-stop questions are delivered by recording a content join
  key and prompting the task thread once to call `northstar_ask` with the exact question content. The prompt is one best-effort
  send whose
  failure is recorded and never retried; the answer's authority path does not depend on it. The
  thread's ask joins the raised question by content, so both waiters resolve on one answer, the
  settlement path records it with who answered, and the question's own controls apply unchanged.
  On a maintenance wake after restart, durable question payloads and decision links resume routing
  and settlement. An interrupted Nucleus-originated delegate send retains its existing board fallback
  rather than being repeated; an interrupted worker-owned ask stays pending without an operator
  decision. A recorded board answer settles the linked Nucleus question. Older digest-only agent
  asks can resume routing when the worker retries with the same content. The proof-only release GO
  question is the exception: it is board-only and never prompts an agent to relay the decision.
- **Delegation fails closed.** `delegateDecision` refuses an operator-only kind, even though nothing
  raises one through it today, so a future route can't hand one to an agent by accident (2026-11-06).
- **No native operator question to lose.** Nucleus raises no operator-only question on a native
  surface: proof-only release GO goes directly to the board (task 572) and a stranded stop is a
  delegated `process` question (task 687). The recovery that returned a lost native question to the
  board is deleted, with the operator-only gates on the two raise paths. Answer settlement of a linked
  board decision is unchanged, and recorded `operator_question` events stay readable.

### Slice 13 — workers own their decisions (task 573)

Tom, 2026-11-02: "A lot of these don't need to be questions, the workers are still being
submissive and not being responsible for their own work in a lot of cases." The responsible
worker and reviewer prompts carry the worker ownership rule, ahead of the ask-in-turn rule
(Slices 11 and 12):

- **Own the task end to end.** The worker makes the judgment calls within the brief itself —
  design choices, how to interpret a boundary, which of several valid approaches to take, how to
  fix what the reviewer found, how to validate — and records each material decision and why in
  the PR body as a short `Decisions` list the reviewer can check. The reviewer is the author's
  safety net, not the operator.
- **Ambiguity is decided, not asked.** When the brief is ambiguous the worker picks the reading
  that best serves the brief's stated outcome, says so in the PR, and carries on.
- **A stop clause stops one action.** A "stop if..." or "stop and report" clause in a brief means
  stop that specific risky action and choose a safe alternative within scope; it never means end
  the turn and ask.
- **Ask only for product or scope changes and releases or outward actions.** Raise product or
  scope changes once through `decision.add` as a discussion with context, options and a
  recommendation. Do not ask approval for work already within the brief. Budget extensions,
  including past 2x, are delegated; binary approve/hold choices approve by default under Tom's
  2026-11-03 rule, and the decision records that reason.
- **`blocked` is for what is outside the worker's control** — a missing dependency, a broken
  environment, an external system — with what was tried. A decision the worker could have made is
  never a blocked report.

Old-lifecycle prompts carry neither the ownership rule nor the ask-in-turn rule. The prompt
fixtures test the ownership wording (decide, record in the PR `Decisions` list, ask only for
a product or scope change or a release or outward action, `blocked` only outside the worker's control).

### Slice 14 — enforce non-delivery ownership (task 575)

- A responsible worker or revision report of `blocked`/`error` is counted as non-delivery only
  when Nucleus reads the task checkout at the run's starting commit and finds no recorded
  `northstar_ask`, explicit external cause, provider-unavailable report or source-proof wait.
  Reports carry a structured `cause` (`external` with a short name, `internal`, or `unfinished`);
  the summary phrase fallback applies only to legacy reports without that field. Admission,
  guard and budget refusals, and proof or native steps in the run, count as external. Unreadable
  Git state and any changed commit keep the existing path. Task 676: only a return that names an
  `impediment` reaches this path; a return without one takes Slice 20.
- An explicit owner no-retry rule suppresses automatic non-delivery and
  unfinished continuations. Such a blocker skips reviewer consult and goes to the planner ladder.
  A `move`, `restart`, `route` or `amend_brief` carrying the rule — the structured
  `noAutomaticRetry` field or the same phrases in its instruction, reason or brief text —
  records it durably on the task (`resolution.noAutomaticRetry` with the control's event as
  provenance, shown in `next` and task detail). It stays in force across that run's launch,
  completion and release, until an owner control lifts it (a permitting instruction or
  structured `noAutomaticRetry: false`). The lift is recorded durably too
  (`noAutomaticRetryDecided`), so the superseded run's instruction can never re-forbid
  retry through the old-run fallback. For rows with no durable owner decision the gate
  also reads the latest owner-instructed run's instruction.
- The same rule gates every automatic relaunch: the reviewer's clean-environment retry, provider
  failover, recovery-started worker or reviewer reruns, and proof re-activations. Nucleus records
  `automatic_retry_suppressed` with the site and kept evidence, preserves a completed verdict, and
  escalates to the planner. Explicit owner controls remain available.
- The first consecutive non-delivery returns the task to the same retained worker with the
  ownership instruction. The second selects a different eligible provider at the same pool
  capability, subject to normal usage-level and availability checks; the reviewer and task
  history remain attached. A third follows the existing planner/recovery path. Task 676: this
  applies only to impediment-bearing returns; a return with no `impediment` takes Slice 20. This does not
  automatically select frontier profiles.
- An owner `restart role=worker` without `fresh` supersedes a pending non-delivery replacement,
  records that disposition, and resumes the retained worker. If no eligible alternate provider
  exists, Nucleus records one planner escalation for the task instead of waiting without an owner.
  `restart fresh` keeps the deliberate replacement rules.
- Durable non-delivery events attribute each result to the reported provider/model. Task detail
  telemetry exposes the task count and its per-model counts.
- The revision prompt stops inviting a stop. Its ending states the ownership rule — continue until
  the outcome is delivered or an external cause stops you, and only that cause may be reported
  `blocked`/`error` — instead of offering blocked/error as the otherwise path. A run dispatched as a
  non-delivery push-back or same-capability replacement never re-embeds the prior no-change return's
  summary as diagnostic context; an externally caused resume keeps it.

### Slice 15 — an unfinished return continues the same round; the cap counts review rounds (task 576)

- A responsible worker or revision `blocked`/`error` that self-declares unfinished work
  (unfinished, partial, remaining work, still unwritten/outstanding, not yet done) with no
  named external cause, and that pushed new commits past the run's starting head, continues
  the same round automatically with the unfinished instruction — even past the revision
  count, and even though it pushed commits. It repeats while each return shows new commits;
  one return with no progress falls through to the Slice 14 non-delivery path. The
  continuation dispatches with cause `unfinished`, which consumes no semantic revision round.
- The revision cap counts review rounds, not author returns: only the first revision
  dispatched for one `changes_required` review consumes a round (`countedReviewEventId`);
  unfinished, non-delivery and owner-approved re-dispatches inside the round do not.
  A pre-merge refusal — reviewed-head gate, prospective gate, merge conflict or failed
  checks — also continues the open round: it consumes no round and never parks at the cap
  (#823 review finding 1); a repeated refusal of one unchanged head keeps its own bounded
  attention stop. The cap parks only on a new `changes_required` past the cap
  (`capParkedReviewEventId`); an author return inside an owner-approved round — unfinished,
  partial or errored — never parks the task for another owner disposition. `next.outcome`
  stops presenting `revision.exhausted` as a fresh owner gate while an approved round is
  still open (an author revision started after the latest cap park), matching the
  `parkedAtCap` control gate, which now reads the latest cap park rather than the oldest.

### Slice 16 — a task keeps one worker thread (task 577)

- A task's worker thread is replaced only when (Tom, 2026-11-02: "The only time a new worker should
  be needed is if the first one has a provider failure and can't continue, or it is upgraded to a
  different model"): the retained worker can't continue (a provider failure, quota exhaustion,
  an agent observed in `error` with no active turn or pending permission, the agent closed or
  archived, or its context or session unrecoverable, including an ineligible retained profile), or
  the task's worker profile actually changes to a different model on an approved and effective
  route. An errored agent's observed error is recorded as the failure detail, and automatic routing
  excludes that same profile while preferring another eligible profile. Worker restart and
  automatic failover use the existing replacement on the same workspace, branch and PR without a
  recovery coordinator; committed and pushed work carries over. A within-level route needs no
  sign-off; a frontier or above-ceiling route needs the operator's board sign-off on that task and
  profile.
- Every other path continues the same retained worker agent: recovery actions, "remap"
  restarts, owner restarts without a model change, route requests still waiting on sign-off,
  non-delivery push-backs, and unfinished (stalled) continuations.
- One guard (`core/recovery/worker-replacement.ts`) enforces it in the replacement path itself: `restart`,
  `route`, `move to=work` with fresh, the stalled-turn continuation, and the automatic failover
  sweep all read it before retiring the retained worker. A caller that asks for a replacement the
  guard refuses records `worker_replacement_refused` naming the rule (`signoff_pending`,
  `same_model_no_failure`, `fresh_without_cause_or_relay`, `route_superseded`) and continues the
  retained worker.
- A route change waiting on sign-off records the request and changes nothing until it is approved;
  a `route now` to an unsigned request refuses the same way (review 825): the verb fails naming the
  sign-off, the request stands, and the retained run is untouched. Once approved, the next worker
  launch arms it through the existing `worker_route_honoured` path and the sweep retires the worker
  once for the approved model change.
- `restart role=worker fresh` is allowed only under condition 1, on an approved route to a
  different model, or with an explicit operator-relayed reason (the board caller or a relayed
  operator note, which travels on the armed replacement so the sweep can retire on it). A
  stalled turn is an unfinished continuation, not a failure, so a fresh restart after it
  continues the same worker unless a model change or failure applies. A recovery retry for a
  stopped pre-callback worker resumes the retained worker with the task's continuation instead
  of arming a replacement.
- A planner/operator exclusion of the retained worker, a granted extra replacement covering the
  occurrence, and an operator-armed failover reason each count as the operator's explicit
  authorization in the sweep; an unsigned route never arms, so there is nothing to spend.

### Slice 17 — the blocker ladder climbs worker → reviewer → planner → Tom (task 584)

Tom, 2026-11-02: "Workers are supposed to handle blockers wherever possible, should use the
reviewer thread as a second opinion where needed, escalate to the planner automatically when
_really_ stuck and only bother me if all else fails." Also: "I'm having to continuously ask the
planner to unblock them, but that's not how this is supposed to work." The ladder is the only
path for a stuck responsible task (`server/blocker-ladder.ts` owns the pure parts):

- **Worker.** It decides within the approved outcome and records material decisions in the PR.
  A recommendation is a decision: if it can name the bounded action or diagnostic it would run,
  it runs it without asking permission. Transient forge failures, including 5xx, belong to the
  worker: wait and retry. Safe alternatives preserve all existing gates.
- **Reviewer first (Tom, 2026-11-05).** A remaining worker ask defaults to the task's retained
  reviewer, even if the worker requests the planner. This is advice from the one reviewer,
  not a second review or verdict. The reviewer answers within the outcome or explicitly returns
  `Decision: planner` with a reason for a planning ruling, which enters the planner path once.
  Without a retained reviewer, the ask reaches the ordinary planner route. Operator-only
  matters retain their existing classification and operator route.
  The mechanism gives a silent reviewer the delegate window before advancing to the planner;
  a closed or archived reviewer advances immediately. Unknown delivery never authorizes another send.
- **Reviewer second opinion.** Worker prompts no longer require a consult when the worker can
  act. A genuinely unresolved blocker may use the retained reviewer. When a run ends `blocked`
  without having asked, Nucleus sends the blocker to the retained reviewer as a short consult
  turn (`reviewer_consult*` events fence the send): no verdict and no review round, just advice
  returned into the same worker thread, which continues as a `consult`-cause revision that
  consumes no semantic round. A provider failure keeps the ordinary replacement (Slices 2 and
  14), and a source-approved proof round keeps its own episode (Slice 9): the proof wait was
  the reviewer's own routing, so the ladder stands down and the non-delivery path never
  counts that round.
- **Planner, automatically.** Still blocked after the consult, or a cause genuinely outside
  the task (environment, shared gate, another task, a needed ruling), opens one planner
  escalation per cause (`planner_escalation*` events) as a delegated decision: the live project
  planner (`project.set-planner`) first, then the live Nucleus planner, then the task's live origin
  thread, then a short-lived decider.
  The question carries the task context, the blocker in plain words, the reviewer's view and the
  concrete options. The task
  waits with the planner under the `escalated` stop and gets no more worker turns until the
  answer applies through the ordinary verbs with delegated authority (a direction returns the
  worker; stop and a named wait settle explicitly). Only an explicit `Decision: operator` reply — a
  planner or decider that says it cannot decide — creates the Spec 032 decision that reaches
  Tom; a timeout or an unusable answer never does, and unknown delivery is never re-asked.
  Available ordinary move, restart, route and effect-retry choices come from `next`, with
  their effect; force, discard, source acceptance and choices needing additional authority
  are not delegated. A refused choice returns its refusal to the same delegate once. An
  unanswered or refused action remains open. A wait names a task, a future offset timestamp,
  or an existing operator decision; task waits use `set_prerequisite_wait`, and a settled
  condition resumes the parked step. A lost wake outcome remains unknown and is not replayed.
  The activity records the question, answer, applied action and refusal. An ordinary owner
  verb that leaves no stop closes the open question even if the original stop has changed.
  A coordinator's explicit stale-version refusal rebuilds the current plan and retries once,
  still bound to the report and its work identity.
- An `agent_ask_delegation_unknown` record is terminal for delivery recovery: later reconciliation
  never emits another unknown record or repeats the send. Once its originating run ends and the
  task no longer has the matching stop, Nucleus settles the ask as `agent_ask_superseded`.
- **Tom, last.** Only release or outward actions, product or scope changes, frontier or above-ceiling
  profiles, or a planner that explicitly says it cannot decide, reach the operator. Budget
  extensions, including past 2x, remain delegated under approve by default, Tom 2026-11-03.
  The operator's board answer settles the escalation through the same ordinary verbs, relayed.

Any blocked or error result from a responsible task that leaves the task waiting enters this same
ladder, regardless of whether the result came from the worker, revision, executor, reviewer,
recovery or closeout role. Results that already have a defined continuation keep that continuation;
the ladder handles the remaining wait. Nucleus retains the reported cause as the task reason and in
the planner question. A repeated result for the same cause attaches to the existing escalation.
Proof-only refusals keep their unspent allowance and retained reviewer, and the planner question
and stop expose the available `proof` owner verb.

When no reviewer thread is retained, Nucleus selects an independent reviewer through the normal
reviewer profile selection and creates its retained thread for the consult without a review
round. If selection or launch cannot produce a reviewer, Nucleus records the failure and
escalates to the planner with the missing second opinion.

A repeated blocker never loops: a run that ends `blocked` on the same cause as the task's open
planner escalation attaches to it (`planner_escalation_attached`) instead of starting another
worker turn or another ask. The same ladder replaces the operator-first stops: the revision-cap
park for a responsible task escalates to the planner instead of "project owner disposition
required" (each cap park is its own episode; the delegated cap answer applies with delegated
authority through the parkedAtCap gate, and the owner's own verbs still override), and
`RESPONSIBLE_QUESTION_WAIT` (the joint worker/reviewer question on the third non-converging
round) goes to the planner first — it is a delegable question, answered by the planner or
decider before any operator surface. Ordinary recovery routing remains in place; when its
coordinator reports blocked or error and leaves a responsible task waiting, that report enters
the same planner ladder. Task detail telemetry shows blocked reports per task and model
(`blockers.count`, `blockers.byModel`) and where each escalation sits
(`blockers.escalations`: worker, reviewer, planner, Tom), rendered in the task's timing
section.

### Task-owned force and critical review (task 723)

Launch prompts direct self-force through the CLI's `NUCLEUS_TICKET` file; callback
credentials are not copied into launch environment variables.

An authenticated worker, reviewer or retained recovery run may force `move` or `retry_effect`
only on its own task. The reason states observed evidence, including recovery bookkeeping stops;
`next` exposes these forms. Self-force moves refuse planner/operator holds and active
dispositions; they cannot settle a scope or release ruling. Planner and operator force authority stays unchanged. Force settles
one recorded effect without replaying it; a forced workspace archive stays visible as left on disk,
with an ordinary retry that re-observes delivery and runs all archive proofs.

A forced merge still needs an applied `ready_to_merge` verdict at the exact head or explicit
operator source acceptance. Worker and recovery force cannot waive a failed check. Only the
retained reviewer can waive a failure at its own applied approval's exact head, naming the check,
job URL and why the diff cannot have caused it; uncertainty refuses. GitHub-required checks stay
binding. Forced checks are recorded and named in closeout.

`queue.critical` is one boolean, false by default, readable on the task and in `next`. An explicit
false is the same submission identity as an absent flag, so a replay reconciles its task. Only a
planner or operator can change it after dispatch; enabling it refuses every task-owned force,
including reviewer check waivers. Each fresh automatic reviewer selection requires a model
independent of every author model and a Spec 053 capability rating at least the worker's current
profile. Re-routing to a stronger worker raises that floor for the next fresh reviewer.
Unrated profiles or workers cannot meet it, and frontier profiles awaiting sign-off are unavailable.
If no eligible profile is available, ordinary reviewer selection proceeds immediately. The fallback
is recorded on the task, shown in `next` and named in closeout; it never holds review up.

### Slice 18 — workers on related tasks message each other directly (task 621)

Rollout step 3's remainder, installed. The model says a worker "may message other
workers"; `northstar_message` lets it. A worker or reviewer on a task sends a short
message to the current worker (or reviewer) of another named task (`to`: a task
reference such as `effigy#590`, a bare number on the sender's repository, or a task
id; `role`: worker, the default, or reviewer; `text`, at most 4000 characters).

- **Same transport as `northstar_ask`.** It rides the same per-run MCP binding with
  the run's authenticated identity on every provider, so the sender's identity comes
  from Nucleus and cannot be forged; a foreign or mistyped run sends nothing.
- **Delivery to the role's current agent.** A live recipient's thread receives the
  message labelled with the sender task, its role and the source project, and the
  information-only rule. With no live recipient (between runs, held, parked), Nucleus
  records the message, tells the sender it is queued, and the maintenance sweep
  delivers it when that role's next turn starts. A delivery that fails stays queued
  for the next wake. A recipient that finishes before delivery expires. Terminal
  recipients refuse plainly, as does a task with no agent for the role at all.
- **Information only.** A message grants no authority and changes no brief, hold,
  verdict, budget or any other task state; the delivery text says so, and rulings
  still climb the planner ladder (Slice 17). A reply is just another
  `northstar_message`.
- **Bounded.** The send tool refuses text over 4000 characters; a recipient task
  accepts at most 20 messages per rolling hour; an identical message (same sender,
  recipient, role and text) inside that window is dropped and reported. An identical
  retry of the same call is idempotent inside that window — the recorded receipt
  returns without a second delivery — and past the window it is a new message again,
  under a derived row id, subject to the same duplicate and rate rules. In the
  sweep, only a recipient whose task row is gone expires its queued messages; a
  transient delivery failure stays queued for the next wake.
- **Recorded on both tasks.** Each message is one row shown in the task detail's
  Messages group (sent and received), with activity events on both tasks; the
  worker and reviewer prompts name the tool in one line (`RESPONSIBLE_MESSAGE_RULE`),
  as does the nucleus skill.

### Slice 19 — the operator stops every active thread while paused (task 650)

Installed. While Nucleus is paused, the operator can stop every remaining active
thread now instead of waiting for the drain, and each stopped thread resumes in
its own agent when the queue starts again. Tom asked for this on 2026-11-03
after stopping project-g#218/#219/#220 and effigy#611 by hand around a Paseo
restart and releasing them on unpause: the feature makes that one action plus
unpause.

- **One control, two surfaces.** `queue.stop-threads` is one service method the
  board menu and the CLI share. It is an operator control, and it refuses unless
  Nucleus is paused. Selecting Stop in the menu performs it immediately.
- **What it stops.** Every Nucleus-owned agent turn currently running: workers,
  revisions, reviewers, executors, recovery and closeout coordinators, and
  proof-only runs. Each turn is cancelled through the existing durable stop and
  active-turn cancellation path (observe, intent, cancel, sent or uncertain),
  and an unreadable or mismatched identity is never stopped. Worktrees,
  branches, PRs, uncommitted work, review state and every hold are kept; no
  dispatch hold is added. Planner and other non-Nucleus threads are never
  enumerated.
- **The marker.** Each stopped run records a `paused_stop` marker (operator,
  time, run, agent and role; the task row for the initial worker thread), so
  nothing treats the stop as a failure, a non-delivery, a stall or a reason to
  start a coordinator, and no budget, retry or replacement counter moves: the
  callback reminder, the closed-reviewer reconciliation, the transient-provider
  resumes and the failover arms all yield to an unresolved marker.
- **Seamless resume.** On unpause, Nucleus resumes every marker oldest stop first
  in its own agent thread: one continuation turn telling it the queue was
  stopped and it should pick up where it left off, the same retained-thread
  continuation a `restart role=…` (not fresh) delivers. That includes an agent
  the daemon closed meanwhile whose session persists. A thread that cannot be
  resumed, or whose provider failed, is replaced under the ordinary rules
  (#577/#605/#610): the worker or revision arm is the ordinary failover sweep;
  a reviewer or coordinator falls back to the ordinary stopped-run handling.
  Uncertain deliveries retry in place with the same message identity (three
  attempts) before that arm. The marker clears once the run resumes, and the
  audit pass settles any resume the unpause moment could not finish.
- **Board.** The header shows how many threads were stopped while paused and,
  after unpause, how many resumed or are waiting to resume. Each task card
  shows "Stopped while paused" until its thread resumes.

### Slice 20 — a no-impediment return continues the same worker (task 676)

- A responsible worker or revision `blocked`/`error` report that names no `impediment`, records no
  external cause (structured `cause` external, provider-unavailable, source-proof wait, recorded ask,
  or admission, guard, budget or proof step for the run), and pushes no commit past the run's starting
  head continues the same retained worker in the same thread. It is the `unfinished_continuation` path
  with reason `no_impediment`: no new verb, no coordinator launch, no review round consumed. Its
  instruction says setup is confirmed, the work is to be done now, and the next report is either an
  open PR or an `impediment` naming the concrete failure. The summary's words never decide it.
- At most two no-impediment continuations per worker thread (counted by the thread's `agentId`).
  The third such return goes to the blocker ladder: reviewer consult, then planner. Slice 14's
  non-delivery push-back and provider switch no longer apply to these returns; they apply only to
  returns that name an `impediment` with no change.
- `impediment` is an optional typed string on `blocked` and `error` reports (the command or provider
  message, at most 4000 characters). Any other status refuses it. A report with one keeps today's
  handling, and so does a provider failure, a typed external cause or an unfinished return with new
  commits (Slice 15).
- The check reads the one task's events and one `git rev-list` at completion time. It adds no scan
  across tasks.
- Recognised external wording keeps its existing handling. A return whose summary carries a provider failure
  (the exhaustion classifiers: quota, plan, rate-limit, transient, prompt-size) or any legacy external phrase
  (provider quota, service or network unavailable, credentials unavailable, permission denied, and the rest of
  the Slice 14 list) takes the ladder. So does a thread whose observed agent error carries the same wording.
  Wording only excludes a return from the continuation; it never triggers one. A negated phrase ("no external
  blocker") does not count.
- A recorded push-back owns its return (`continuationOwnsReturn`). A reconcile pass that waited on a read
  or the blocked hook can resume after another pass has recorded the push-back. It must return rather than
  write blocked/error over changes_requested, which started recovery in the live stalled-pass race (task 676).
- Live evidence (read-only, 2026-11-03 onward, 24 "Worker error:" recoveries): 20 had a recorded
  `non_delivery` with an unchanged head, no provider wording and no ask or proof/admission/guard/budget
  step, and each then recorded a `non_delivery_pushback` before recovery. The override above is what
  turned those pushbacks into recoveries. One revision row took a second non-delivery and a provider
  switch. One reviewer-role row had recorded proof or native evidence and stays on the ladder.

### Not installed

Nothing is left of rollout step 3; the next messaging work, if any, is new design.
The old lifecycle's coordinator machinery was removed in rollout step
4 (below); the owner verbs remain as the operator's board surface.

### Project ownership retires

Project ownership is not a standing role (Tom, 2026-11-02). Authority comes from the operator: at the
board, by answering a task's native question, or through a relayed note quoting the operator. Inside
a task the worker and reviewer hold what they need. Escalations go to the operator as native
questions on the task's own thread, not to a project thread. A planner thread is optional and
ephemeral. This repository's project owner was cleared on 2026-11-02. Projects still on the old
lifecycle keep their owner threads until they migrate; removing ownership from the code (owner
checks, owner routing, the Chatterbox and Supervisor roles) is a later slice.

**Installed (cutover 5, 2026-11-02).** The owner machinery is deleted: `checkProjectOwners`,
`assignProjectOwner`, `claimProject` and `moveOwner`, the `project_owner` authority in the owner
acceptance proof (a caller claiming it is refused like any other non-authority),
`isProjectOwnerThread` and the audit line's owner bit, the Chatterbox inventory, validation and
recovery discovery (`paseo.workspaceChatterboxes`), `project.assign-owner`, `project.claim`, and
the board's owner picker and settings. A reviewer checkpoint stop (budget exhausted, agent closed)
on a responsible task escalates through the planner ladder instead of an owner disposition.
Notices that fell back to the project owner — origin fallbacks, proof-wait attention, scheduled
milestone QA and the drain prompts — go to the project's planner (`project.set-planner`), then the
Nucleus planner (the project that holds origin `inflatable-cookie/paseo-northstar-queue`), then the task's origin thread. Dormancy is re-derived: a
project with no planner and no live owner record is silent. One-time migration, in the same build:
a project with an owner thread and no planner gains that thread as its planner when the thread is
live (observed, not archived), recorded `setBy` Nucleus with a reason; an archived or missing owner
is dropped. Old rows still parse: project `owner`, `ownerAcceptances` and the `project_owner`
records remain readable, and a reviewer instruction's historical attribution still resolves. The
owner verbs themselves, and operator, relayed and delegated authority, are unchanged.

### Slice 21 — a finished task's late report is history (Queue #691)

A completion from any role's run on a `done` or `cancelled` task is evidence, never authority.
`Resolution.complete` and `Engine.complete` route it to `recordFinishedTaskCompletion` before any
phase, ladder or source gate runs: the report is recorded on its run (kept as the run's completion
when none was), the run releases through `releaseRunFromRecordedCompletion`, one
`late_callback_evidence` event names it, and the receipt is kept. The reports boundary
(`core/intake/report.ts`) lets such a run through its stale-run check. Executor runs keep the existing
superseded-proof record (Task 560). The blocker ladder returns without parking a finished task, and
the recovery pass skips finished tasks, so a coordinator's silence cannot escalate one either.

A `restart` on a finished task still refuses (`restart requires an unfinished, unmerged task`).
Its one available form answers an escalation that is already open on the task; that answer
changes no phase. A forced `move` stays an explicit owner verb. The paths that can still write a
non-terminal phase onto a finished task are listed in the Queue #691 PR, not closed here.

## What stays

Exact-head merge, never blindly retrying an effect with unknown delivery, task identity and its
callback credential, capacity admission, and scratch only on the configured work volume. A run's callback
credential is stored in its private ticket, not the launched agent environment. Releasing a run
revokes its stored credential and removes its fallback and MCP ticket files: a released run's
credential authenticates nothing, while run history, completions and receipts remain unchanged.
The stored hash is kept, so re-binding the same run identity (a run re-bound after a restart)
restores the same credential, and a re-issued credential (restart, reviewer continuation,
recovery) replaces the hash and lifts any revocation. Replaced is not released (planner ruling,
2026-11-09, reconciling Tom's 2026-10-19 readoption ruling with #1269): replacing a reviewer
marks its run replaced but does not release it or revoke its credential, so a still-working
replaced reviewer's checkpoint applies as saved progress and its exact-head verdict still
authenticates, with readoption applying it as before; the replacement owns any continuation
delivery. The run is released, and its credential and tickets revoked
unconditionally, only when the review settles: the replacement's verdict applies, a readopted
verdict applies, or the replaced run ends without a verdict. After release nothing
authenticates.

## What went — rollout step 4 installed

The old lifecycle is deleted. Cutover batches 1–7, 2026-11-02: #842 (opt-out and
conversion), #847 (brief verdict/pass gates and the manual verification
coordinator), #848 (automatic author upgrade), #841 (extra-replacement grants),
#846 (project ownership), #843 (owner-recorded external revision), and this
change (the final sweep):

- **Per-task coordinators as a lifecycle.** No Chatterbox→Supervisor relay,
  coordinator assignment or incident reconciliation stands between a worker and
  its reviewer; rulings go through the planner ladder. The closeout coordinator
  (repository manifests) and the one retained recovery thread remain, and old
  episode records stay readable.
- **Owner threads and routing roles.** Project ownership, the Chatterbox
  inventory and the Supervisor routing role (batch 5).
- **Every `responsible` branch.** The code runs one lifecycle; the persisted
  field stays readable for old rows and nothing reads it to decide (this change).
- **The old lifecycle's board panels** (this change): the owner picker,
  coordinator remap, incident rows, coordinator-recovery line and the Spec 053
  demand table are gone from the task detail, with their client state.
- **Checkpoint wording** (this change): the reviewer continuation prompt and the
  budget-exhausted and agent-closed stops name the planner ladder instead of an
  owner disposition, and recovery no longer nudges a coordinator for owed
  verification runs (the verification coordinator is retired).

What stays, deliberately: the owner verbs as the operator's board surface,
operator, relayed and delegated acceptance, proof admission (Specs 054–055),
holds, the worker-replacement breaker, exact-head merge, callback authentication
and capacity admission. "Supervisor" in host-run and process code means the
process supervisor and is unrelated.

### Cutover rulings (Tom, 2026-11-02)

Before rollout step 4's deletion batches:
- `responsible: false` goes. Every task is responsible; the escape hatch for a broken lifecycle is a
  direct PR with operator source acceptance.
- External owner revision (Spec 017's owner-recorded revised head) is deleted. Revisions to an
  external PR go through Nucleus's revision worker like any task.
- Review entry itself stays (Tom, 2026-11-02): "if someone submits a PR, I want to be able to add
  that as a task at the review stage, then if changes are needed, a worker is spawned within the
  task workspace to execute it." Intake at the review stage (`nucleus-review-entry.mjs --lead`, named `northstar-review-entry.mjs` before the 2026-11 rename),
  the retained reviewer and the revision worker in the task workspace are product; the deletion
  removes only the owner-recorded revision path.
- The extra-replacement grant goes; the per-task worker replacement ceiling stays as a loop breaker,
  and a relayed `restart fresh` from the operator is the way past it.
- Brief-frontmatter `mergeHold` stays, as a hold a planner places with a stated reason. There is
  still no default hold.
- Batch 2 landed (2026-11-02): brief-declared `reviewVerdicts`/`reviewPassGate` and the manual
  verification coordinator are deleted ([Spec 037](retired/037-structured-review-verdicts.md)
  retired; nucleus#765 then removed the role's remaining branches, see the
  [orchestration contract](../contracts/orchestration.md)). A brief states its outcome and acceptance in prose; the retained reviewer judges a
  named proof; the retired keys are refused at intake and `amend_brief` with the replacement named.
  Live task project-e#269 (held behind longhorn#084 and a release) recorded the retired fields and
  continues under ordinary retained review; its brief text still lists the subjects for the
  reviewer, and it is not amended here.

## Rollout

1. **Finish what helps both models:** Spec 057, the six-round cap and checkpoint continuation.
   Pause simplification batches that polish machinery this model deletes (B3b–B9).
2. **Pilot the responsible lifecycle on this repository.** A direct PR with operator source
   acceptance is the escape hatch when a lifecycle fault needs repair.
3. **Registration and direct paths:** `task.register` (installed, slice 4),
   operator questions and budget pauses as composer pills (installed, slices 5 and 6),
   worker-to-worker messages (installed, slice 18, task 621).
4. **Migrate project by project, then delete the old lifecycle.** Installed
   (batches 1–7, 2026-11-02, PRs #842, #847, #848, #841, #846, #843 and this
   change): every new task is responsible (an absent flag means true; explicit
   false is refused), with no default merge hold and no verdict or proof gates in
   frontmatter; the coordinator, owner-routing and legacy-panel machinery is
   deleted (see "What went"). Existing tasks complete on their recorded
   lifecycle before the cutover. Why: in the 21 days before, Effigy ran 696 recovery runs against
   616 reviewer runs, Project-c 520 against 394 and Project-f 232 against 143, and
   every open task carried a merge hold.


### Stranded stops and operator choices

Tom, 2026-11-04: “I have no way to answer this in any sensible fashion. It needs
to escalate to the planner, or provide recommended options.” A stranded stop is
a delegated process question: project planner first, then Queue planner. It
offers the existing `next` verbs and forced forms, recommending closeout after
a recorded merge and work otherwise. A selected verb uses the ordinary owner
gates and records the answering planner's authority; inputs still needing a
profile or qualification remain planning directions.

Operator decision creation and supersession always supply choices and a
recommendation, including an explicit `Decision: operator` forwarding. Legacy
free-text and single-option callers receive planning-return and hold choices
rather than an empty board question.

Finished tasks retain cleanup errors in their cleanup record and never reopen
attention because cleanup failed.
