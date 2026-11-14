---
name: nucleus
description: Shape a project's long-horizon direction with the operator (Atlas). Read and write Nucleus planning records (plan.get, plan.set, lanes, lane documents), write and promote briefs and leads, file papercuts and operator decisions, run project QA, and hand over planner ownership. Also plan and submit approved work to the Paseo queue, steer a task with the owner verbs (next, stop, route, restart, move, complete, retry_effect, proof), activate one source-immutable author-side proof execution for an external author, review existing external PRs through review entry, and resolve blocked-task escalations. Use for requests such as plan.get, papercut.add, decision.add, project.qa.run, planner handover, "adopt this PR", "put this PR through the queue", approved dispatch, planning rulings on blockers, and deliberate supersession; planning alone does not authorize execution or abandonment.
---

The data home is `~/.nucleus`, or `NUCLEUS_DATA_HOME` when set.

New Nucleus worker, reviewer and coordinator sessions expose `nucleus_report`,
`ask` and `tell` through MCP (`nucleus ask` and `nucleus tell` on a host without an MCP binding,
with the run's ticket on stdin). Report with the exact run ID in the current instructions. A reviewer
report may also carry an optional bounded `verdicts` array (`id`, `subject`,
`verdict` one of `pass`, `fail`, `insufficient` or `not_applicable`, `evidence`,
optional `note`). Briefs do not require verdict entries or pass gates. A `ready_to_merge` report omits
`reviewResponsibility`; `reviewer` belongs only to `review_in_progress`. A worker
report may name local proof files (screenshots, rendered images, recordings the
brief requires) as `proofFiles: [{label, path}]`, where each path is an absolute
path to a real regular file inside that task's own scratch or worktree, at most
12 files, 8 MiB each and 32 MiB total. Nucleus copies them into its own
per-head evidence directory, records their hashes and lists them with paths and
hashes in the retained reviewer's prompt for that head; nothing is uploaded to
the forge, and no local path belongs in a PR body or comment. A report naming a
path outside the task is refused and nothing is copied. The PR may say that
evidence was delivered to the retained reviewer and give the hashes. Worker
reporting keeps its authenticated run-bound callback socket. Report only through
this run's own binding; never read or use another ticket file under the Nucleus
data home. If a report is refused, report blocked with the refusal through your
own binding. If that is refused too, state the refusal plainly; never try another
ticket or route to bypass it. All other helpers connect directly to Nucleus;
`--via-paseo` selects the compatibility bridge.

## Calling thread identity

The CLI and submit, subscribe and reparent helpers identify the calling thread from its
Nucleus-issued ticket first, then its host's identity. `NUCLEUS_TICKET` names the run
or participant ticket; use the path delivered to this thread. An invalid or revoked
ticket refuses. If neither source exists, the refusal names the sources tried.
Explicit operator and relayed-note paths keep their existing meaning.

Assigning a planner issues an owner-only participant ticket and hands its path over
without messaging the thread: the planner that named itself takes it in that
assignment's response, any other planner takes it in the response to its own next
authenticated call, and only a thread observed live on a host with no
calling-thread identity of its own receives one message. Reassigning or clearing the
planner revokes it, and a planner with no ticket yet shows as pending on the board.
A task's own planner receives the same ticket, keyed per thread and scoped to the
tasks that name it, so it can answer on a host without per-thread identity;
reparenting a task moves that scope and revokes the outgoing planner's ticket.
Every named project agent takes its ticket by the same routes (Spec 060); renaming,
reassigning or unregistering the name revokes it. Caller records use host-qualified
identities; existing bare Paseo IDs still resolve.

### Paseo host

Paseo supplies `PASEO_AGENT_ID` as the fallback identity. Existing documented commands
keep working for Paseo planners unchanged; they do not need to pass a caller field.

## Pull request changelog

For a repository change, add a Markdown changelog fragment under
`changelog.d/`, named `<task-number>-<short-slug>.md`. Do not edit
`CHANGELOG.md`'s `[Unreleased]` section; release preparation folds fragments
there.

## Workspace scratch and selector teardown

Use the current run's `TMPDIR`, `TMP` and `TEMP`. Nucleus owns the recorded
temporary root and removes it after release; never remove that root, its parent
or any directory created outside this run by another task, planner or Nucleus.
Put fixtures in fresh directories under the run's `TMPDIR`. Tests, fixtures
and selectors may remove temporary directories they created during the run
inside that `TMPDIR`. A tool that would delete
outside `TMPDIR` or a root it did not create is a finding to report, not a reason
to skip the selector.

In source-immutable roles (reviewer and proof executor), use a formatter's
check-only form when it would write tracked files. If the repository has no
check-only form, report a selector gap with the formatter command and still run
the other required selectors.

The two agent verbs (task 1108). Name recipients by role, task or project; never an agent or
thread ID. `ask` is a question that waits for an answer and escalates; `tell` is information only.
- `ask` `to`: `"reviewer"` (your task's retained reviewer; falls through to the planner ladder),
  `"planner"` (your task's planner ladder: planner, project planner, decider, then the board for
  operator-only kinds), `{"project": "<key or name>"}` (that project's fallback planner),
  `{"project": "...", "agent": "<name>"}` (one named project agent; refused with its state if
  archived or gone), or `{"task": "<reference>", "role": "planner"}` (another task's planner ladder).
- `tell` `to`: `"reviewer"` or `"worker"` (your task's counterpart), `"planner"`, a task reference such
  as `effigy#590` with `role` (worker, reviewer or planner), `{"project": ...}` or
  `{"project": ..., "agent": ...}`.
Nucleus delivers a `tell` labelled with your role and project. To a working T3 agent it steers into
the running turn; to a working Paseo agent it waits until the agent is idle. Otherwise it queues for
the recipient's next turn or the project inbox, or reports an uncertain delivery that must not be resent. A tell is
recorded before delivery and returns after at most a short inline delivery window; its receipt names
the status and `recordedAt` time, plus `deliveredAt` when delivery is confirmed. If delivery is still
running, retry the identical tell JSON to read the recorded outcome; it never sends the message
twice. A callback timeout says the same. `ask` keeps its bounded in-turn wait because its purpose is
to collect an answer or report that the question is pending. Messages carry information only.
Decisions still go through `ask` and the planner ladder. `nucleus_ask` and `nucleus_message` remain
as aliases for retained sessions.

**Payloads:** pass JSON on stdin with `-`, for example
`node bin/queue-cli.mjs METHOD - <<'JSON'`, then the JSON, then a closing `JSON`
line. A file path still works, and no argument means `{}`. Work from the plugin
root (walk up from this file's directory to the ancestor holding
`bin/nucleus-submit.mjs`).

## Approve by default

Tom, 2026-11-03: binary approve-or-hold decisions "will almost always be yes otherwise progress just
halts". Don't put a yes/no approval in front of Tom, and that includes extending a task's budget past
2×: decide it (approve) and record why. Only two kinds still go to Tom: releases and outward actions
(tag, publish, external resources), as a decision; and product or scope changes, as a proper
discussion with the context, the options and your recommendation, never a bare approve/hold
question. Frontier or above-ceiling profiles keep their board sign-off, or a
planner grant the operator has already said yes to (below). A grant is permission to request
them where needed, not an instruction to use them.

## Settle questions within the task

A recommendation within the approved outcome is yours to carry out, including a bounded diagnostic.
Record material decisions and reasons in the PR. Wait and retry transient forge failures such as 5xx.
For a remaining worker question, `ask` defaults to the retained reviewer for a second opinion;
this adds neither a reviewer nor a review round. The reviewer answers through `question.answer`.
When a planning ruling is needed, put `Decision: planner — <reason>` in its one-line `answer`:

```sh
nucleus question.answer - <<'JSON'
{"questionId":"<question id>","answer":"Decision: planner — This changes the approved product outcome.","reason":"A planning ruling is needed."}
JSON
```

The CLI supplies the calling reviewer identity. `decision: "planner"` is not a supported field value.
Without a retained reviewer, the ordinary planner route answers. Operator-only matters keep their
existing route; a silent reviewer advances after the delegate window, and a closed or archived reviewer advances immediately.

`queue.critical: true` asks automatic selection for an independent reviewer model rated at least as
capable as the worker, using Spec 053 ratings, and disables every task-owned force. Each fresh
selection rechecks the worker's current profile. When no eligible rated profile is available,
ordinary selection proceeds immediately and records the fallback on the task, in `next` and closeout;
profiles needing sign-off count as unavailable. Only a planner or operator can change the flag
after dispatch through `set_routing` with `critical: true` or `false`.

## When to contact the Nucleus planner

Message the Nucleus planner only when Nucleus itself is wrong or in the way: a Nucleus defect, a refusal
or wait that contradicts the documented route, a verb that should apply but doesn't, or a Nucleus
route you can't find in this skill. Say what you ran, the exact refusal or state, and the task.
Project matters stay with your project: progress reports, merges, QA results, project decisions,
dependency holds and operator questions about your own work. Don't send status updates or "no
action needed" notes. Operator decisions go to Tom through `decision.add` or a native question, not
through the Nucleus planner (Tom, 2026-11-02: "They shouldn't escalate project-specific issues to
you").

## Submit approved work

For an authorized brief, `lead.submit` checks, approves and promotes it in one call,
waiting for the task reference. Pass the complete brief as `body`:

```sh
nucleus lead.submit - <<'JSON'
{"repository":"owner/repo","title":"Build the feature","body":"---\ntitle: Build the feature\nqueue:\n  complexity: medium\n---\n\n## Outcome\nBuild the feature.\n","agent":"<your agent ID>","note":"Tom authorized this work"}
JSON
```

Optional fields are `baseBranch`, `lanes`, `tags`, `hostId` and `hold`. The note
records existing operator authorization; the brief itself grants none. A failed
check returns `{lead}` with `check.message` and no approval or task. An existing
same-title lead or task in that repository is returned without creating another
or changing the lead; inspect an existing lead before deciding its next step.
Task results are `{taskId, reference}`. Admission backpressure stays explicit.
If delivery is lost, inspect `lead.list` for that repository and title, then
`lead.get` and its operation before retrying. Existing submission routes remain
available below.

Require execution authorization already in the conversation; do not treat a
promoted document as execution approval. A committed handoff needs
`kind: northstar-handoff`, `handoff_mode: worker-pr-loop`, `worker_mode:
implementation`, `dispatch_authority: orchestrator`, `status: ready-to-launch`,
`base_required: pushed-main`, a title, `queue_dispatch: nucleus` and
`queue_approval` naming the authorization, with no template placeholders.

```sh
node bin/nucleus-submit.mjs /absolute/repository/docs/handoffs/worker.md
```

When the repository's `.paseo/queue.json` is v5 or absent (or the brief is
Nucleus-held), submit brief mode instead; its frontmatter needs only `title`,
`queue_approval` and optional `queue:` routing, and the file is never committed:

```sh
node bin/nucleus-submit.mjs --brief --repo /absolute/repository /absolute/brief.md
```

Add `--dry-run` to validate and print the derived submission. `--coordinator`
assigns an existing coordinator; omission lets Nucleus select one. `--base`
defaults to `main`; `--commit` fences the expected integration head. The helper
returns a durable operation receipt; remote validation runs afterward:

```sh
node bin/queue-cli.mjs operation-status - <<'JSON'
{"operationId":"returned-operation-id"}
JSON
```

Wait for `succeeded` and `result.taskId` before submitting dependants; quote the
`reference` (`repo#N`), but start a worker PR title with the bare number
(`304: Task title`). A failed operation needs its reported condition repaired;
inspect an uncertain response before retrying.

For an attention-held task control, inspect its operation first. Only when it
has an execution-authored `preSendReceipt` may the owner explicitly ask Nucleus to
reconcile the same occurrence, passing the operation's recorded input hash:

```sh
node bin/queue-cli.mjs operation-status - <<'JSON'
{"operationId":"returned-operation-id","reconcilePreSendInputHash":"recorded-input-hash"}
JSON
```

Nucleus rechecks the receipt and current evidence and refuses when proof is
missing or conflicts. This call never resends the control or releases a hold;
an old diagnostic or an empty timeline is not a receipt.

`queue:` routing: `dependsOn` (all must reach `done` first), `lane` (one key) or
`lanes` (a list, never both), `scope` (`general`/`complex`), `complexity`
(**required**: `very_low`, `low`, `medium`, `high` or `very_high`), `preferredProfileId`,
`requirePreferred`, `thinkingOptionId`, `skipPRReview`, `siblings: false`,
`notifyOriginOnCloseout`, `completionNotificationAgentIds`, `critical` (default false; see below), `mergeHold` (needs
`mergeHoldReason`), `interactive` (see below),
`responsible` (optional readable field; explicit `false` is refused and absence means
true),
and role requests. `reviewVerdicts`, `reviewPassGate` and `manualVerification`
are retired (Spec 058 cutover 2): a brief states its outcome and acceptance in
prose, and a needed hold uses `mergeHold` with a reason; submissions carrying
the retired keys are refused with the replacement named.

```yaml
queue:
  scope: complex
  complexity: very_high
  profileRequests:
    worker:  {profileId: actual-frontier-profile-id, reason: "why", required: true}
    reviewer: {profileId: another-profile-id, reason: "why", required: false}
```

### Required proof

When a brief asks for counts from the live Nucleus store, record the worker's
counts as evidence and treat any live-store verification as a planner follow-up.
The reviewer judges the recorded counts; do not require the reviewer to open or
query the live store, and do not frame that check as awaiting proof.

Before review, each worker and revision also runs the affected test files its
committed change can reach: `effigy test:affected --run` at the exact head
(nucleus#1164, Tom 2026-11-12). If an affected file fails, rerun it alone on
`origin/main`. When it fails there too, it was already broken: list the file and
failing test in the report and PR rather than fixing it. Only failures unique
to the branch block review, and the reviewer applies the same rule. The reviewer
judges the author's reported command and file count at that head and reruns it
when that evidence is missing. Full suites and `effigy qa` stay on milestone QA.

The repository's AGENTS.md Validate section selects which covering checks
apply; it never waives a proof the brief or handoff names as required, and
nothing a repository writes can remove that rule from the worker, revision or
reviewer prompt. Name each
required proof explicitly in the brief's prose (its `## Acceptance` section or
body), and have the retained reviewer judge it at the exact head: a missing,
insufficient or failed named proof is a `changes_required` (author can still
produce it) or a `blocked` with `reviewResponsibility: environment` (owner-gated
or unavailable), never a silent approval. (Spec 058 cutover 2 retired the
`reviewVerdicts`/`reviewPassGate` frontmatter that used to enforce this
mechanically; submissions carrying those keys are refused with the replacement
named — prose acceptance plus `mergeHold`.) When the proof needs an owner to
enable it (a native run, a live activation), set `mergeHold: true` and
`mergeHoldReason: "why"`: the hold keeps the task off the merge gate until the
owner releases it, because the reviewer can only report the gap, not perform the
activation. When source review passes and only those release gates remain, the
reviewer reports `ready_to_merge` at the exact head with the gates as follow-ups;
the merge hold keeps the task from merging until the owner releases it. An owner's exact-head source acceptance still stands in for an
independent review; it mints no verdict or proof credit.

#### Author-side proof execution

When the brief names ONE author-side selector an external author cannot run
themselves, name it structurally so Nucleus can execute it:

```yaml
queue:
  proofExecution:
    selector: "effigy test unit -- test/proof.test.ts"
    inputs: ["sha256:<64 hex>"]   # optional pinned inputs
```

Then activate it with the owner verb `proof` (`action: "proof"`, `taskId`,
`version`, `reason`) as the operator at the board, or with a relayed operator
note. `next` lists or refuses it. Nucleus dispatches one
genuine proof-only `executor` run on the same task, in the task checkout, at the
exact published PR head with tracked source and index unchanged; its prompt
forbids writes, commits, pushes, branch swaps, installations, review
publication, merges and dispatch, and requires `proof_executed` with
`proofResult {status, selector, exitCode, evidence}`. Recorded evidence lives in
`proofExecutions` (run, agent, model, selector, inputs, head, result) and never
changes the source-author declaration. The allowance is one per task and is
never refunded on a denial, failure, lost reply or unknown delivery; a second
call sees the spent execution. Dispatch is single-flight: one executor per
task and head, never two. A second trigger while an executor run is unreleased,
or while that head is already recorded, refuses before anything is sent, so
concurrent triggers produce exactly one executor and one allowance. A dispatch hold or pause refuses activation
(release it with ordinary hold semantics); a merge hold is untouched. A
distinct later independent reviewer still performs its own review and proof. A
superseded executor's late report, or its timeline showing the selector ran,
settles its record as historical evidence: it spends no allowance, is never a
pass, and can never satisfy proof-only closeout — a reviewer approving a
historical receipt alone closes the qualification failed.

An author-side executor can attach capture files to its `proof_executed` report
as `proofFiles: [{label, path}]`, with top-level `head` equal to the current
pushed PR head. Save them under that executor run's TMPDIR or the task checkout.
Nucleus accepts at most 12 files, 8 MiB each and 32 MiB total, copies them into
task-retained per-head evidence storage and lists the copies beside the proof
receipt in the retained reviewer's prompt. The files must come from this
executor's own scratch or the task checkout; copies survive removal of the
executor scratch. Never publish their contents or local paths to the PR.

When a reviewer approves the source at the exact head and names that declared
selector as an external proof, Nucleus runs it without a question: it starts the
same executor at the approved head (Spec 058), records it as `delegated` with
the note "Nucleus ran ...", and the retained reviewer judges the evidence on its
next turn. It starts once per head. A proof the brief does not declare keeps
its ordinary route.

#### Proof-only qualification of a merged commit

A release qualification for code already on the base branch uses a Nucleus-held
brief with both declarations:

```yaml
queue:
  proofOnly:
    commit: <40-character commit on origin/main>
  proofExecution:
    selector: "effigy test unit -- test/release-qualification.test.ts"
    inputs: ["sha256:<64 hex>"]
  requiresOperatorGo: "Installs over the live tool and uses existing VM state"
```

`proofOnly.commit` is a commit (or commit resolved from a tag) that promotion
proves is an ancestor of `origin/<base>`. The task has no worker, task branch
or PR. Nucleus provisions a clean detached checkout at that exact commit in its
Builds workspace and runs the one declared selector via the source-immutable
executor route, with ordinary host-run admission and a durable receipt.
Provisioning transport failures retry provisioning; they do not enter worker
dispatch or worker recovery. A real executor failure stays on the
proof-execution failure path. A task-level qualification spends its one
execution allowance even when the result fails or delivery is uncertain.

When `requiresOperatorGo` is present, Nucleus raises a native `release` question
that only the operator can answer. The proof remains unstarted until GO; a
planner or decider cannot answer it. While GO is open, the task waits on the
operator: `next` marks `route`, `restart`, `move` and `retry_effect` unavailable,
and the planner ladder offers nothing. After execution, one retained reviewer
judges only the receipt. A pass closes the task with the receipt as release
evidence; a failure closes it failed with the failing cases for the planner to
brief a fix. No dummy PR or reopening a merged task is involved. The operator can accept a settled passing receipt after a failed
qualification when its exact run, commit, selector and inputs match, preserving
the original failed outcome and review. The board presents that operator-only
acceptance; it creates no run, review verdict, allowance or other proof credit.

#### Delegated answers and the task's planner

A task's planning questions climb one ladder: the task planner first, then the
project planner when it is a different thread, then a short-lived decider, then the
board for operator-only kinds. The task planner is the thread that submitted or
promoted the task, or the one a brief named with `queue.planner`; the project
planner keeps project-level matters and is the fallback rung. A rung observed
archived or gone is skipped at once; a silent rung still times out.

Nucleus sends a short `<nucleus-system>` message only when the planner is idle.
Answer by running the exact `nucleus question.answer` command in the message, then
write nothing else in the thread. Chat output is never an answer. Busy time counts
toward the ten-minute window; without an answer, the same question falls through
to the next rung and then a short-lived decider. Reviewer consults use the same
command.

```sh
nucleus question.answer - <<'JSON'
{"questionId":"id-from-message","answer":"the answer or offered choice","reason":"one line explaining why"}
JSON
```

The command binds authority to the calling thread. A repeated answer returns the
recorded answer. Instead of `questionId`, pass `taskId` (a UUID or `nucleus#1070`)
or `reference` to answer the one open question delegated to your calling thread on
that task. No match or several matches refuses; use the exact `questionId` for a
retry or to select among several questions. A planner may add `overtakes: ["exact-decision-id"]` when the ruling
settles those decisions; never infer IDs or match wording. A decider cannot overtake
other decisions. Use `choice` instead of `answer` when copying an offered label.

Classify a worker's question from its meaning; its supplied kind is only a hint.
Answer from the brief and repository within the existing authority. Only product
or scope changes, releases or outward actions, and frontier or above-ceiling profiles
need the operator. If only the operator can decide, send `decision: "operator"`
and a one-line `reason`, omitting the answer. A product or scope change is a
proper discussion through `decision.add` with context, options and a recommendation.
Do not ask approval for work already within the brief.

Approve binary approve/hold, approve/wait or approve/deny questions by default
unless they concern those operator-only matters. Budget extensions, including past
2x, remain delegated: choose the offered extend option. Record the reason
`approve by default, Tom 2026-11-03`. A reviewer consult gives advice within the
approved outcome, not a review verdict or publication.

The answer resolves the same native question, clearing its sidebar and composer
pill. It applies through the ordinary verb with `delegated` authority, never
`operator (board)`. Activity records who decided, the choice and reason. The
operator can still override through ordinary verbs. An unknown send is never
blindly repeated.

Every PR has exactly one reviewer, the retained Nucleus reviewer. Never create extra
reviewer, review-lens or "independent native" reader agents, or workspaces for them; a
needed native proof runs once through the task's `proof` route (Spec 058, Tom 2026-11-01).

Set a project's fallback planner with `project.set-planner` (`key`, `agentId` or
null). The planner may set itself; the calling thread is recorded as `setBy`. A
thread that is not registered yet is registered under the default name `planner`.
This grants nothing except answering a project's delegated questions when a task's
own planner cannot, and receiving the project-level notices. A task's own planner
is recorded on the task: its owner, or the thread a brief named with `queue.planner`.

A project's named agents are its non-task threads (Spec 060): `agent.register`
(`project`, `name`, `purpose`; the CLI registers the calling thread, the board
names one live thread), `agent.unregister` (`project`, `name`) and `project.agents`
(`project`) for the list with each entry's host, live state, last seen and fallback
marker. Names are unique per project, a thread holds one name, and renaming or
reassigning a name revokes the old participant ticket. `project.set-planner`
marks any registered agent as the fallback; clearing it leaves the thread
registered, and the fallback cannot be unregistered while it holds that role.
Its address belongs to the role: `agent.register` refuses to give the fallback's
name to another thread (move the fallback with `project.set-planner` instead),
and a fallback whose preferred default name is taken registers under a free name
such as `planner-2`.

### Complexity and demand

Every new task names `queue.complexity` (Spec 053). A submission, brief check or
promotion without it is refused with a message naming the field. Complexity is
how capable a model the work needs, not how long it is. Each run's demand is
that complexity moved by its role (the coordinator needs two steps less by
default; the operator sets these offsets in Settings) and by the usage level.
Nucleus rotates among every profile rated at or above the demand, leaning toward
cheaper ones, so rate honestly: `medium` for ordinary work, `high` for subtle or
cross-cutting changes, `very_high` only when the strongest model is needed.

### Usage level

The operator sets a host-wide usage level (Settings → Dispatch limits slider, or
`queue.usage`): `minimal`, `low`, `normal` (default), `high` or `maximum`, with
an optional `until` when it returns to normal. The level moves every run's
demand: `minimal` two steps down, `low` one, `high` one up, `maximum` two. It
also caps cost: below `high`, a profile above the level's cost ceiling (at
`normal`, very_high cost) needs a signed-off request. A profile rated
`frontier` (capability runs `low` to `frontier`) needs one at every level below
`maximum`; at `maximum` it joins automatic selection. Automatic eligibility is
capability tier × level, cost × level and On/Off, nothing else. A brief
needs no `profileRequests` just to get a stronger model; raise `complexity`
instead. Read the level in force from the board state's `usage`.

A request for a profile above the cost ceiling, or rated frontier below
`maximum`, is a question
to the operator, not a pin: Nucleus opens a decision on the board, and the role
runs on automatic selection until the operator approves, picks another profile
or declines. Nothing waits for the answer. Prefer setting `complexity` over
naming a profile; ask for a specific profile only when the work needs it, with
a reason the operator can judge. `routingPolicy` shows each request's sign-off.
Before rerouting a frontier dispatch, read `routingPolicy` on `task.next` (or
`queue.detail`), which explains each profile the task names under the current
level.
Change it only on the operator's word (Spec 052):

```sh
node bin/queue-cli.mjs queue.usage - <<'JSON'
{"level":"maximum","until":"2026-10-21T09:00:00Z"}
JSON
```

### Planner frontier grant

**A grant is permission, not an instruction.** Frontier and above-ceiling profiles cost the most,
so naming one for a task normally needs the operator's sign-off on that task. A grant gives one
planner standing permission to name them without a per-task question, for a block of work. It does not
say which model to use, and it changes nothing about how other tasks route.

What a grant does and doesn't do:

- It **does** let your own `profileRequests` (and `route`) name a frontier or above-ceiling profile
  and take effect immediately, for the tasks where you ask.
- It **does not** pin anything. A task without a `profileRequests` entry routes automatically, exactly
  as before: Nucleus picks among every eligible ordinary profile by `complexity`, role and usage
  level, leaning cheaper. Ordinary profiles stay the default for everything.
- It **does not** move automatic selection or demand. Frontier profiles don't join the automatic pool
  because you hold a grant (they join only at usage level `maximum`).
- It **is not** "the profile to use". Holding a grant for a frontier model and then requesting it on
  every task, or routing trivial work to it, is the misuse to avoid.

How to use one:

1. Set `complexity` honestly on every task and let automatic selection do the work. That covers
   nearly everything.
2. Request a frontier profile for a specific task only when that task needs it: the work is at the
   top of the scale and the ordinary pool can't serve it, or the operator asked for that model on
   that work. Give the reason in the request.
3. End the grant when that block of work is done.

Right: a grant for a strong model while a hard migration runs. Its two hard tasks request that model;
the docs fix and the test cleanup in the same week have no request and route to cheaper profiles.
Wrong: requesting the granted model on every task "because we have a grant", or treating
non-frontier profiles as unavailable while it stands.

Ask for one:

```sh
nucleus queue.routing-grant - <<'JSON'
{"action":"request","reason":"why this block of work needs frontier"}
JSON
```

The CLI fills `caller` from the calling thread (its Nucleus ticket or host identity). Optional `profiles` (named set; omit for every frontier
and above-ceiling profile) and `until`. A repeat while a request is open joins it. An active grant is
reported as already standing. Only a board yes activates it; a relayed `decision.answer` does not. The
operator revokes from Settings → Limits.

End it:

```sh
nucleus queue.routing-grant - <<'JSON'
{"action":"end","reason":"this block of work is done"}
JSON
```

`routingPolicy` on `task.next` says when a request was covered by a grant. When that grant ends, expires, is revoked or is archived, the request quietly returns to automatic selection and the policy names the ended grant; a new grant or a fresh explicit request after the end enables frontier again.

### Dispatch limits are the operator's, in Settings

Nucleus's host-wide dispatch limits (global and per-project task slots, the
papercut allowance, the Paseo-call bound, the stall threshold, and the hold and
lane-drain timers) change only from the operator's Settings → Dispatch limits
screen, on the plugin or on the local board with a link from `nucleus ui`.
`queue.capacity` refuses every other route plainly: "only the operator
changes Nucleus's dispatch limits, in Settings. Nothing changed; do not retry." The
CLI refuses `capacity` too, and a repeated call changes nothing. Never look for
another way in, including invoking the plugin bridge yourself: that is the
Settings surface, not an agent route, and an agent must not use it. If a limit
blocks approved work, say which limit and why, and pick up other ready work.
`queue.capacity-state` reads the values in force and the record of applied
changes — each with its time, surface and full before and after values. This is
accident prevention, not permission: a deliberate same-uid imitation of the
bridge is not stopped, and the record names the surface without claiming who
sent it.

### The local board link

`nucleus ui` prints a link to the local board: `127.0.0.1` only, a token in the
link, valid for 8 hours by default. `nucleus ui` opens it (`--no-open` prints only), and `nucleus ui
--revoke` revokes every outstanding link. The link is the operator's board access. An
agent never mints a link for itself, and never pastes one into a prompt, a handoff or
a log. Board Settings writes work with a live link, and the socket still refuses
them. The contract is the service-boundary contract, "Local web board".

### Interactive tasks

When the operator wants to work with the worker before it submits, add
`interactive: true` to `queue:`. Pair it with a strong worker through
`profileRequests.worker`, and give the reason for a frontier profile (the
operator signs a frontier request off on the board):

```yaml
queue:
  interactive: true
  profileRequests:
    worker: {profileId: actual-frontier-profile-id, reason: "operator will work with it interactively", required: true}
```

The worker builds the first tranche, then stops without reporting and
summarizes what to try. The operator then talks to it in its Paseo thread. The
operator's instructions there may change the scope, and the worker follows
them. When the operator tells the worker to submit, it commits, pushes, opens
the PR and reports `ready_for_review`, and ordinary review takes over. While
the session runs, the board shows "Interactive" ("Interactive · your turn"
when idle) and `next` shows the `interactive` wait. Nucleus sends no reminders
and starts no coordinators. Do not steer an interactive task with owner verbs
during its session; the operator drives it in the thread. Set the mode before
dispatch; an amendment can change it only while the task is queued. Use it
only when the operator asks for an interactive task (Spec 051).

Lanes must exist first; create and inspect them with `lane.upsert`, `lane.status`,
`lane.keep` and `lanes`. Use `plan.get` / `plan.set` (with `idle: "<reason>"` for a board with no now or next lane that waits on purpose) and `lane.document.get` /
`lane.document.edit` for the project plan and lane documents. Lane edits accept the
read's `digest` as an optional extra stale-edit fence alongside the required
`version`; send the old digest with the new text. A mismatch writes nothing.
`plan.get` returns a version but no digest, so `plan.set` uses its version fence.
Projects are permanent
records: `project.upsert`, `project.get`, `project.park`, `project.unpark`,
`project.remove`, `projects`, `agent.register`, `agent.unregister`, `project.agents`.
Project ownership is retired (Spec 058 cutover 5): `project.set-planner` marks
the project's fallback planner — the registered agent that answers delegated
questions and receives the project-level notices, and the thread `to: {project}`
resolves to. It grants no authority, and there is no project owner to claim or
assign.
Repository settings (`repository.set`, `repository.get`, `repositories`) carry
closeout authority, the prospective-merge validation command, formal-review
login, the optional `affectedTests: { command }` used for worker and reviewer
validation prompts, and the optional milestone `qa`
command and the optional hosted-check policy
(`checksPolicy`: `all` by default, or `required` to gate only the checks GitHub
requires for the PR's base branch and record the rest as advisory evidence).
The operator edits these fields in Settings → Projects, inside each project's
repository rows. Worker, revision and reviewer prompts include the affected-test
rule only when `repository.get` shows an `affectedTests.command` for that repository.
Formal reviews need macOS: the reviewer token is read at call
time from the macOS login keychain (service `nucleus.github-reviewer`, account
`<org>`; store it with `security add-generic-password -a <org> -s nucleus.github-reviewer -w`).
A token kept under the legacy service `paseo-queue.github-reviewer` is still
read as a fallback.
The Settings → Limits section also lists every project slot override for editing
or removal; each project's Slots field is the same setting, and clearing it
returns to the inherited value. Project in-flight capacity is always twice its
slots and has no separate field.
`required` is refused before anything is written unless GitHub's required-check
surface is positively readable for the repository's canonical origin and its own
default branch; an unsupported plan says so and names the choice, and `all` always
remains available.
A heavy repository can opt into compile-only tasks (Tom, 2026-10-09): workers run
a compile of what they touched, docs checks, and any proof the brief names, and
no tests. The repository's `AGENTS.md` Validate section is the only place that
choice lives (the per-repository validation policy setting is retired, Tom,
2026-11-09): write the compile-only rule there, and Nucleus's fixed prompt line
points every worker at it. The
planner then reconciles with milestone QA — see
[plan](references/plan.md#reconciling-compile-only-repositories).

Renaming a repository on GitHub does not move its Nucleus records. Use
`repository.rekey-preview` (writes nothing) then `repository.rekey` with
`{source, target:{origin, path?}, expectedSourceRevision, reason, idempotencyKey}`,
keeping the preview's revision: settings, numbering (purged numbers included),
tasks, outcomes and their search identity, leads, lanes, drafts, decision
targets, project membership and QA move in one durable atomic step, while
operation payloads, hook events, host-run evidence, the shadow journal, receipts
and an outcome's proof keep the old identity. Numbering continues; a target
occupied in any current family (even a bare counter) refuses, and a swap goes
through an unused temporary name one step at a time. Same origin with a
different `path` is a path-only step: every path hint of this origin moves,
numbering stays, and the source origin is not occupancy. Same origin with no
path, or the same path, still refuses. When the settings row has an empty path,
the step derives the checkout from the source's own records, or takes
`sourcePath` when they disagree. Settled host-run history
stays authentic and does not occupy the vacated name; a running or
capacity-holding host run refuses. A record that already names a different
origin is never claimed through a shared checkout path: name the origin, not the
path, when two repositories share one. Nucleus never renames a checkout, remote
or GitHub repository: quiesce the repository, apply the Nucleus step, then do the
GitHub and remote change, and do not let auto-discovery submit from the old
checkout in between. A lost reply is reconciled with `repository.rekey-receipt`
by the same `idempotencyKey`; never repeat with a new key. Spec 056 owns the
desktop-final/CLI-takes-name order and the quiescence gates.

### Report-only tasks

A brief that asks for a report and no code change may opt in with
`queue.reportOnly: true`; set `queue.reportLane` when the report belongs in one
specific lane document. Attach that lane to the task. The worker writes the
report to the Nucleus lane document and reports `report_ready` with its exact
`artifact: {key, version, digest}`. Nucleus releases the worker and waits in
`Planner` state for the project planner (or Nucleus planner) to use `complete`
with that artifact. The planner may return an inadequate report with
`move to=work` and an instruction. This path starts no reviewer or blocker
escalation. A task without the explicit brief opt-in cannot report `report_ready`.

## Register a thread as a task

Any thread can put itself on the board and own the work it is about to do (Spec 058). Run it from a
separate clean worktree on its own branch, never the registered checkout or the integration branch:

```sh
node <queue-plugin>/bin/queue-cli.mjs task.register - <<'JSON'
{"title":"What this task delivers","description":"Outcome, constraints and acceptance","complexity":"medium","caller":"self"}
JSON
```

The CLI fills `caller` from the authenticated Paseo thread. The calling thread becomes the worker on
its current branch, and the task runs the responsible lifecycle: open the PR from that same branch
(never a new one), report `ready_for_review` with its number and head, and work with the one
reviewer Nucleus assigns until it merges. Refusals name their reason (registered checkout, detached or
dirty tree, foreign repository, an already-owned workspace).

Planned briefs run the responsible lifecycle. Explicit `queue.responsible: false` is refused; absence means true. `manualVerification` is retired (Spec 058 cutover 2): the verification coordinator is deleted, so no submission can select an old lifecycle; stored rows keep the field readable.

## Steer a task: `next`, then the verbs

`next` is the read-before-steer call. Run it first, then call what it lists.

**When something is stuck:** read `next`, then use `force: true` on `retry_effect` or `move` when
it is the obvious exit, with a reason naming observed evidence. An authenticated task worker,
reviewer or recovery run can force only its own task, including recovery bookkeeping stops;
`critical` tasks refuse every such self-force. Self-force moves also refuse existing holds and
active dispositions, which remain with their planner or operator. The project planner, Nucleus planner and operator
keep their force authority. A forced retry settles the named uncertainty without observing or
sending it. A workspace archive settled this way stays visible as left on disk; use its ordinary
retry to observe and archive it with the existing proofs.

A forced merge needs an applied verdict at the exact head or explicit operator source acceptance,
with a relayed note quoting Tom when the operator is not calling directly. Worker and recovery
force cannot waive a failed check. Only the retained reviewer may waive a check at its own applied
`ready_to_merge` head, naming the check, job URL and why the diff cannot have caused the failure.
Do not force when that is uncertain. GitHub-required checks remain binding; forced checks appear
in closeout.

On a responsible task paused for its budget, `next` offers `extend_budget`. It adds one
default increment and clears the budget stop through the same path as the question's
`Extend the budget` answer. Use the board caller or relay an operator authorization
note; an ordinary worker caller cannot authorize extra budget. A merge hold does not
hide the budget question because it blocks merging, not runs. A dispatch hold still
suppresses it because no run can start until that hold is released.

```sh
node bin/queue-cli.mjs next - <<'JSON'
{"reference":"owner/name#12"}
JSON
```

It reads the store only and answers with the phase and reason, the active run
(role, agent, profile, status, last activity), the PR head, the current stop or
wait with its reason, owner and evidence, the hold fences, and every owner verb
with `available`, prefilled `args` and the plain `refusal` for each that does not
apply. To steer: copy an available verb's `args`, add the free-text fields its
`fill` list names (a reason or instruction), and call `task` with them. The CLI
fills `caller` from the calling thread (its Nucleus ticket or host identity); each applied control writes one
`owner_control` event naming the verb, caller, owner-thread match, reason and
phase before and after. If nothing is available, the refusals say why.

**`route`** points one role's next run at a named profile on any unfinished task:
`action: "route"`, `role` (`worker`, `reviewer` or `coordinator`), `profileId`, a
required `reason`, optional `thinkingOptionId` and `now`. It records the profile
on the field the selection path already reads, so the next revision, reviewer or
coordinator uses it; naming a profile a recorded worker exclusion covers lifts
that exclusion. An owner-routed reviewer is used even on the author's model — the
waiver is recorded and the prompt names every prior author — while automatic
selection keeps preferring independent reviewers and a fresh reviewer never
reviews its own head. With `now: true`, a live run is durably stopped and replaced
on the new route, keeping workspace, branch, PR and commits.

**The replacement ceiling.** Nucleus permits eight worker retirements before
automatic failover and ordinary owner replacement stop. `route role=worker now`
cannot pass the ceiling. Only a direct operator call or an operator-relayed
`restart role=worker fresh` arms a replacement beyond it; the existing worker
replacement guard still checks the route and cause. After that replacement is
consumed, automatic replacement stops again until the operator relays another
fresh restart. The retired replacement-grant history is stripped from stored
rows (schema 54, task 989) and never grants or spends a replacement.

**`restart`** gets a stopped, stalled, idle, checkpointed, blocked or errored run
going again: `action: "restart"`, a required `reason`, optional `role` (derived
from the phase), optional `instruction` and `fresh` (default false). Nucleus derives
every run, head and checkpoint identity, settles the incidents, recovery episodes,
reminders and checkpoint holds it supersedes with history kept, and starts the
next run: the retained agent continuing, or a fresh agent on the role's current
route when `fresh`. Both keep workspace, branch and PR. Absent creation is
re-observed and retried under the same run ID. A stalled live turn is stopped
durably first. Coordinator retry does not take `fresh`; use
`route role=coordinator now` to replace a coordinator agent.
On a task stopped by its owner, restart first and release second: once the exact
retained participant is observed idle with no active turn or permissions,
`restart` is offered under the owner's dispatch hold and records the instruction;
`release` then delivers it once on the same authenticated run and thread. The
stop audit names the targeted run, including an already-idle initial worker, and
`next` reports that observed run as `stopped`, not `running`. An idle worker with
no matching owner stop keeps its ordinary handling. Releasing first leaves a pass in between
that can act on the stale state. An active recovery run still fences the restart;
let it finish or `stop` it. While the task is reviewing, `restart role=worker`
doesn't apply; use `move to=work` under the hold instead, then release.
A checkpointed reviewer has two ends to its retained-agent continuation: it spent
its checkpoint budget, or its own agent was observed closed. `next` records that
plainly, refuses the same-run continuation, and offers `fresh: true` there beside
`move to=review`; the run, checkpoint and verdict history stay as evidence.
Nucleus revisits an unfinished checkpoint from current facts. Admission and the
existing recovery bound decide whether it opens a coordinator episode; the
coordinator can request retained continuation or another permitted verb. A
retained restart delivers at most one continuation for that checkpoint. Only an
ordinal above the maximum reached by any reviewer at this head resets the loop
coverage measure; a replacement reader still below that maximum does not. `next` and the applying control are one
task-scoped plan, so the verb `next` offers is the verb your report applies: the
transition settles the reporting run and the episode it answers, and you are
never asked to report `cannot` because of Nucleus's own bookkeeping.

While a valid checkpoint, the exact head and the reviewer identity still hold,
that retained continuation is the supported action: `move to=review` displaces
the retained reviewer and discards its coverage, so use it only when a fresh
review is what you intend (the budget is spent, the agent was observed closed,
or the source at that head changed). Repeated coordinator work that moves no work
is bounded: after three runs for the same work identity Nucleus escalates to the
owner.

On a blocked or errored task that has a PR, a restart without a role resumes
from the run that blocked: the worker's own block returns to the worker, and a
reviewer's resumes into review. Name `role: "worker"` to continue the retained
worker on its PR whatever blocked (Tom, 2026-10-23: "Worker continues"), with an
`instruction`, or `fresh: true` for a fresh worker on its route. `next` offers
the no-role form and says so in its note.

For ordinary workers, `next` names the fresh observation required before restart,
including when saved activity still shows an active turn. The same offer serves
owners and authenticated coordinators. Execution can recover stale saved activity
only when it proves the same agent and workspace idle, with no active turn or
permission; an offer can still refuse on that fresh evidence.
Resolve a permission request first. Restart does not steer a healthy active
worker; `stop` it first, or use `route now` to stop and replace the role. Routing
without `now` selects a subsequent run, and the same profile does not mean the
same reader. A refused restart explains the actual wait or supported choice in
the control error and operation diagnostic. Read that reason before choosing
another action; a failed observation is never permission to resend work.

**`stop`** halts live work now and parks the task: `action: "stop"`, a required
`reason`, optional `role`. Nucleus cancels every busy turn of the task's runs (or
that role's), including the initial worker, and places an owner dispatch hold.
It changes no run state. Next, `restart` continues the same agent with an
instruction, `move` sends the task elsewhere, or `release` lets dispatch carry
on. It applies while Nucleus is paused. Your next `restart` or `move` releases the
stop hold; any other hold stays. Use it to take control of a running worker
or reviewer.

Owner verbs apply while Nucleus is paused. The task's state changes at once, and
new agents start once Nucleus is unpaused. A restart that would deliver at once (a
reviewer checkpoint continuation, or re-creating an uncertain run) is recorded
and delivered after unpause, or after the dispatch hold is released. If it no
longer applies by then, it is refused once and never retried.

**`move`** sends the task to another step: `action: "move"`, `to` (`work`,
`review`, `merge` or `closeout`), a required `reason`, and an optional
`instruction` for `work`. `work` returns the task to its author for a revision (a
gone author is replaced on the worker route; a stopped or checkpointed reviewer
lease is superseded first). `review` supersedes accepted credit and answered
episodes and starts a fresh reviewer at the verified current head. `merge` needs a
`ready_to_merge` review at the exact current head, re-verified at the forge, and
enters the ordinary verification turn — a clean integration-base advance is not
drift. `closeout` needs the PR observed merged and never mints a review. For a
dispatched task whose PR merged at a descendant while its retained checkout stays
at the recorded source, `next` also lists `qualifyingFill: ["qualification",
"head"]`: give both or neither. Neither is the ordinary same-head closeout. Both
record an exact-final-head operator source acceptance, and `head` must be the full
final PR head you read from the PR, never the recorded task head. Use the operator
board for it: an agent submitting from its own CLI shell is refused while that
shell is still active, and waiting cannot make that call inactive. A
queued review-entry task that never
dispatched and whose PR merged outside Nucleus has no reviewed head at all, so
`next` lists `move closeout` with `fill: ["reason", "qualification"]`. Nucleus
observes the merged head and commit at the forge, proves they descend from the
intake and recorded heads, and records your explicit exact-final-head operator
source acceptance — the same authority proof as a merge acceptance — beside the
unchanged recorded source head, with the missing review evidence disclosed.
Without that acceptance the verb refuses and the held task is untouched; the
merge alone is an observed fact, never review or approval, and it creates no
reviewer, worker or proof run. A refused
move changes nothing. A live run in the way no longer refuses `work`, `review` or
`merge`: the move cancels its turn and settles it. Only a durable side effect
refuses: unknown delivery, a pending authenticated delivery, or a blocking
recovery effect. The refusal names what clears it.

If a dispatched task's PR merged externally at a descendant while the clean retained Nucleus workspace remains at its earlier recorded head, use the same `move closeout` with an explicit `qualification` and the exact merged `head` you accept. Nucleus independently observes that head and merge commit at the canonical forge, proves ancestry and retained workspace identity, and checks participant and effect custody before recording acceptance and merge together. It preserves the source checkout and earlier evidence; an unknown or different final head, unsafe source, active participant or unresolved effect refuses. See [Spec 050](../../docs/knowledge/specs/050-owner-task-controls.md).

For routed work whose blocked/error report cleared the PR URL and head, `review`
derives the known PR from `resumePrNumber`. Omit `prNumber`; a matching number
takes the same path, and a different number refuses. `next` reads stored facts;
applying the move still verifies inactive participants and the clean canonical
worktree, published branch and open ready PR at the same exact head. Unknown
delivery or failed source, identity or version checks refuse before binding or
settling anything. No complete historical tool timeline is required.
Tom selected “Retained PR routing into review (Recommended)” on 2026-10-19:
the owner may accept the delivered scope for independent review without another
author-ready callback. This preserves authenticated reports, checkpoints,
lineage, counters, proof allowances, deadlines, profile requests and holds;
it supplies no verdict, validation or merge credit. The
[orchestration contract](../../docs/knowledge/contracts/orchestration.md) owns
the bounded ruling.

**Qualified owner acceptance** (`move to=merge`, 2026-10-17): when the exact
current head carries a released, published `changes_required` verdict, `next`
lists `move merge` with `fill: ["reason", "qualification"]`. Add
`qualification: "<what the owner accepts, and any deferred work>"` and Nucleus
records an explicit qualified acceptance at that head — separately from
the untouched reviewer verdict — and runs the ordinary verification, merge and
closeout gates against it. No new review round is needed just to record the
acceptance. The caller must prove authority: the operator at the board
(`caller: "operator (board)"`), or a relayed operator ruling (`relayed: true`
plus the required authorization `note`). Anything else — an ordinary caller, a
coordinator action, an owner-sounding caller string, no caller — is refused
with nothing written. Merge holds stay real (release them with their own
control), required checks and pre-merge hooks still refuse into the ordinary
revision loop (an identical failed check at the unchanged reviewed head parks
with its own next action instead of buying another author or reviewer turn),
a changed head invalidates the acceptance for merge, and the
reviewer verdict is never rewritten or credited as an approval. Since
2026-10-20 the same call also offers when no review evidence binds the current
head (no verdict, an interrupted reviewer, an unpublished verdict, or a head a
docs-only resolution moved after the verdict): Nucleus records an operator
source acceptance whose `next` note names the missing evidence, and no verdict
is invented or rewritten. If GitHub's PR head has moved past the task's
recorded head, the move refuses and names it; to accept that exact head, add
`head: "<full SHA>"` to the acceptance. Nucleus judges the acceptance at that
head (an older verdict is history, not credit) and records the adopted head.

**`complete`** finishes a dispatched task with no PR to merge (report-only or
no-code): `action: "complete"`, a required `reason`, and an optional
`artifact: {key, version, digest}` naming the exact lane document accepted. It is
accepted only when it exactly matches this task's delivered `report_ready`
artifact; later versions on the shared lane do not invalidate it. Its stored
version and digest are still checked against the lane document text. It is
refused by a terminal task, merge intent, a recorded or open PR, a live run, or
a task that never dispatched. One transaction releases the finished runs,
settles the attention, incident, recovery, reminders and checkpoint intent it
supersedes (history kept) and records a `done` outcome marked owner-completed.
No brief heading is proof of scope.

For an unpublished authenticated reviewer verdict at the current PR head, `next` lists
`review_publication.<runId>` with its actual verdict. `retry_effect` observes the
remote review and requires exact findings, marker, login, head and state.
`changes_required` remains changes required. A mismatch or unavailable inventory
refuses without discarding the stop; never bind it by marker alone or normalize
the findings. A recorded result and coordinator `cannot` do not authorize another
identical recovery episode. Publications at earlier heads remain history and are not offered for settlement.

If the owner chooses revision instead, use `move to=work` with a reason and any
specific instruction. A completed recovery can settle after fresh idle proof
while a dispatch hold remains. Active, unknown-delivery or unobservable recovery
still refuses. The publication intent and findings remain uncredited history.
Release the hold separately to launch the author; the move itself does not lift it.

**`retry_effect`** observes and then binds or retries one recorded failed or
uncertain side effect: `action: "retry_effect"`, a required `reason`, the `effect`
key copied from `next` (omit only when exactly one is pending) and `discard: true`
only to discard unpublished checkout state an occurrence still pins. The effects
are a holding hook occurrence, an unproven workspace creation, an unconfirmed
workspace archive, a failed runtime retirement, a skipped or uncertain
build-output cleanup, a merged task's holding retention gate, an unrecorded review
publication, a planning base the retained workspace cannot dispatch from, a
rebind-displaced workspace still unarchived, a cancel or supersede disposition frozen at its workspace
proof or archive, and the latest failed advisory hook occurrence.

When no retained PR number is bound, `move` with `to: review` and a different
`prNumber` still uses separate replacement PR binding (strict branch, base and
head reconciliation); use it when an accepted result names the wrong PR.
Found done it binds; proven absent it retries once; unknown outcome refuses with
what was observed.

**Uncertain merge response** (`merge-response.merge-response`, Spec 038): when a
merge request gets no usable response, Nucleus does not resend at once. It
watches GitHub until the PR has stayed open, unmerged, on the reviewed head with
no auto-merge or queue entry for two minutes of continuous proof (the default;
`uncertainMergeRetryMs` in `settings.json` overrides it). Any drift restarts the
window. Then it sends one guarded re-issue at the same head. If the window cannot
finish within 30 minutes, or the re-issue is also uncertain, the task goes to
`needs_attention` and keeps the integration turn until the merge outcome is
settled. `next` lists the response; `retry_effect` with that `effect` re-observes
it now, and never re-sends the merge by hand.

For a done task, `next` lists a failed or unconfirmed owned workspace archive as
`workspace_archive.<id>` with its actual failure cause, even when preflight failed
before native archive intent. Retry that effect after repairing the cause.
It joins automatic cleanup's serial lane, bypasses only that workspace's backoff
and repeats the ordinary source, ownership, participant liveness, retention and
applicable complete-tool proofs. A fresh `closed` participant with matching
identity and no active turn or permission needs no historical-tool read; idle or
error participants still do. Unknown or contradictory observations refuse.
Unknown delivery is observed before replay. Failure remains visible; unavailable
history never counts as complete coverage or successful archival. Closure adds
no tool completion or review credit and leaves runtime retirement required.
A report-only `done` task whose branch moved beyond its planning base (a
blocked negative result kept as donor source) uses the same effect. Nucleus
derives the source head from the clean task branch. That branch must descend
from the planning base, contain every authenticated reported head and be
published at origin. Archiving preserves source; it is not product acceptance.
No PR, review or merge truth is recorded, and the remote donor branch stays.
See the [archive retry contract](../../docs/knowledge/contracts/orchestration.md#workspace-archive-retry).
If a done workspace can never prove clean, published source (for example its
worktree record was pruned and every attempt fails in Git), or a cancelled
preserved workspace's contents must be given up for its retirement, only the
operator's explicit ruling to lose its contents permits `discard: true` on that
`workspace_archive.<id>` retry, from the board, or a
relay with `relayed: true` and the ruling as `note`. The unsaved contents are
deleted and nothing is claimed published; every other proof and fence still
applies, and a worktree Git no longer knows is deleted only after Nucleus proves
it orphaned at its exact owned path. A cancelled task's phase, original preserve
disposition, reports and terminal result stay unchanged, and the record names
the exact task, workspace and directory it covers. Never discard on your own
judgment; prose in a reason or note is never that authority.

For a completed cancelled task with a preserved Nucleus-owned workspace, `next`
also lists `workspace_archive.<id>`. An explicit `retry_effect` authorizes later
retirement: use the board, or an attributed operator relay
with `relayed: true` and its authorization `note`. Nucleus re-proves clean published
source, closed unmerged PR truth, idle participants, ownership, holds and retention.
If those contents must be given up, the same operator ruling permits
`discard: true` here too: Nucleus records the decision for that exact task,
workspace and directory before any effect and waives only the clean-head and
publication proofs, so an older retirement authorization or prose never stands
in for it.
The original preserve disposition stays history; the later authorization and
archive result are separate. Adapter preflight refusals stay held; repair the
cause and retry the same effect. Unknown archive delivery is observed first; a
positive present-workspace observation permits fresh proofs and the same
idempotent archive request, while a failed observation permits no replay. A
failed runtime retirement stays visible. Do not use `queue.remove`
or native archive to clear the bookkeeping.

A cancel or supersede that stopped at its workspace step keeps its fence and
lists `disposition_workspace.<id>`. Retrying it re-runs the recorded proof with
the same task, fence and version — the original kind, replacement link, reason,
work disposition and effect history are never rewritten, and already settled
thread archives or hook emissions are not repeated. Re-run it after the evidence
is back: a replacement workspace restored, an archive custody problem repaired,
an unknown archive observed.

When the recorded `retained_by_replacement` proof cannot be produced at all
because the replacement workspace was retired after its merge, the same verb
takes `workDisposition: "archive_if_empty"` from the board, or a relay with
`relayed: true` and the operator's authorizing `note`.
That is the ordinary safe proof — clean queue branch, every local commit
published on the canonical origin, ownership, idle threads and retention gates —
so dirty, local-only or unknown work is preserved and nothing is claimed about
the replacement. Nucleus appends one attributed proof-policy transition and keeps
the original request as history; only `archive_if_empty` is selectable here, and
no discard, force archive or auto-fallback exists. A stale version, a different
effect key, an unauthorized caller or a conflicting policy refuses with nothing
written; a lost reply replays the same recorded step, and a restart resumes the
same recorded step without launching any worker, reviewer or coordinator.


The last four narrow controls (`continue_review`, `retry_resolution`, `resolve_escalation` and `repin_instruction`) were retired on 2026-10-19; use `restart` and `amend_brief`. `restart role=reviewer` continues a checkpointed reviewer on its same run: Nucleus derives the run, head and checkpoint, and you give the `reason` and an optional `instruction`. With nothing stopped, `restart` re-runs a parked step: a never-dispatched park, a blocked task behind its retained PR, or a parked resolution check. On a blocked, reviewed task, `restart role=reviewer` with an `instruction` returns it to a fresh review with that instruction, after checking GitHub's PR head. Choose a replacement worker profile with `route role=worker`. Your next verb answers an escalation. When nothing else applies, an owner `restart` with the answer as its `reason` closes it, even on a finished task; a coordinator's restart never answers one. The old focused verbs fold into the owner verbs: return a retained pre-PR worker or re-create a proven-absent creation with `restart role=worker`, replay pre-dispatch validation with `restart`, return the task to its author with `move to=work` (no `instruction` keeps the pending one or the review findings), and ask for a fresh review with `move to=review`.

A continuation whose send is uncertain stays uncertain until evidence settles
it: the reviewer's own callback, or the exact message in its timeline, settles the
delivery and the operations that sent or inspected it. Never resend to inspect
it. Repair the reported cause, read `next`, then restart again. Unrelated
unresolved effects still refuse. A reviewer whose Paseo runtime does not report
its mode or thinking level is unknown, not changed, and continues; a reported,
different value still refuses.

The superseded narrow actions were deleted on 2026-10-15; use the verb that
replaced them. Two narrow controls stay because no verb expresses them:
`set_routing` (pre-dispatch scope, complexity and preferred-profile changes; planner/operator
`critical` changes also work after dispatch, with a `reason` and a relay `note`) and `exclude_worker` (exclude an agent or profile from
the task, with a `reason`). Assign a coordinator profile with `route role=coordinator`.

## Holds, cancellation and brief edits

Every task read or verb accepting `taskId` also accepts a task reference there,
such as `nucleus#1070`. `task`, `next` and `queue.detail` also accept `reference`
instead of `taskId`. A short repository name must be unambiguous; use
`owner/repository#1070` when names overlap. Stored identities and callbacks stay UUIDs.

On `task` owner verbs, omit `version` to act on the current task without a lookup.
An optional `phase` fences the phase you observed. An explicit `version` keeps the
existing version fence. Admission pins the current version before any durable
effect; later conflicting changes still refuse. Task replies include `changes`,
the names of the fields changed, alongside the updated task.

```sh
nucleus task - <<'JSON'
{"taskId":"nucleus#1070","action":"set_dependencies","dependsOn":["nucleus#1069"]}
JSON
```

`next` offers `set_dependencies` before dispatch. Its `dependsOn` list replaces
the old list; `[]` clears it. Prerequisite references work as well as UUIDs.

`next` lists `release` and `keep_hold` for each hold fence, with a summary
naming the holder and its condition; release only once that condition is met.
A refusal that starts "Task changed" names the version the task is now at: read
`next` again and reassess rather than resending the stale payload. `lead.list`
without `pageSize` refuses when the result is too big for one response; page with
`pageSize` (1-8) and the returned `next` cursor as `before` until it is null.

Use `hold`/`release`/`keep_hold` for an external pre-merge or dispatch gate; a
hold needs a `reason`, takes `kind: dispatch|merge` when both fences could apply,
and may name its own end with `until` (a task ID or offset timestamp). Review and
every other step still run under a merge hold. Use `set_dependencies` and
`set_prerequisite_wait` to change prerequisites, and `set_lane` for lanes.

Cancel or supersede only with an operator-authorized disposition, and reconcile
every owned thread and workspace first: no orphaned threads, and uncommitted work,
commits, evidence and PRs preserved or explicitly transferred. A blocked task is
an open obligation; do not cancel, replace or complete it because it is
inconvenient. A worker's own `blocked` report comes to you as an escalation with
no coordinator. Choose an offered ordinary action, or return a concrete direction to the
worker. A wait must name a task reference, a future ISO time with timezone, or an open
operator decision ID in its reason. Nucleus applies the choice and resumes a named wait;
a refusal comes back once. You can also apply an ordinary verb directly: when the stop is
gone, it closes the open question. `withdraw_cancel` reverses a cancellation still in `intent` or
`draining`. Bulk dispositions use `nucleus-bulk-dispose.mjs start|status|retry`.
To change a brief before merge, use `amend_brief` with the complete new text and a
reason (refused after merge intent). On a committed handoff, `amend_brief` with
only a `reason` re-pins the instruction to the artifact at the integration base.
For a queued, never-dispatched brief, amendments also apply changed `dependsOn`,
`lane`/`lanes`, `scope`, `complexity`, preferred-profile fields, `profileRequests`,
`critical`, `siblings`, `interactive` and `laneDocuments` together. Removing a
previously declared routing field restores its submission default; omitted
`interactive` keeps the existing mode. Profile
requests still need their ordinary validation and sign-off; a brief grants no
operator authority. Changes to `reportOnly`, `reportLane`, `skipPRReview`,
notification recipients or other unsupported routing fields refuse and name every
field, including delivery-field removal in a body-only amendment. After dispatch, routing
edits refuse. A refusal leaves both the brief and routing unchanged. Merge holds
and proof declarations retain their existing amendment rules. The reply's
`changes` lists what actually changed.

Invalid payloads name the field and the schema's accepted shape, including union
alternatives. For example, `project.qa.get` accepts `id` or `repository`; `runId`
is an unrecognized key.

Never run `git stash` in a repository with Nucleus worktrees: `refs/stash` is shared
by every worktree. Commit work in progress on your queue branch.

## Change a task's owner

A task has one owner thread: its attention, completion, hold-release and planning
notices reach it. When a thread is replaced or a task changes hands, change the
owner in one step (Spec 040); never unarchive the old thread or edit the live store:

```sh
node bin/nucleus-reparent.mjs NEW_OWNER_AGENT_ID --task TASK_ID [--task TASK_ID ...] --reason TEXT
node bin/nucleus-reparent.mjs NEW_OWNER_AGENT_ID --project PROJECT --from OLD_OWNER_AGENT_ID --reason TEXT
```

The calling thread (its Nucleus ticket or host identity) must be the tasks' current owner, the task's own planner,
the project's registered planner, or the Nucleus planner; the operator can do the same from the board. A
planner uses this for a task whose origin is missing or was never a thread (for
example an external submitter's label such as `sweep`), usually naming itself as
the new owner (task 602). Project ownership is retired (Spec 058 cutover 5): a
project's owner thread is no longer an authority, and a thread that was a
project's owner only reparents the tasks it still owns. The new owner must be a
live planning thread, not a worker, reviewer or coordinator; the old owner may
be archived or gone. The project form moves every open task of that project the
old thread owns. Holds the owner placed, pending owner notices and the creator's
own completion nomination follow the new owner without further steps; third-party
holds, settled notices and finished tasks stay as recorded. Repeating the request
changes nothing.

A project may name a fallback planner with `project.set-planner` (`key`, `agentId`
or null; the calling thread is recorded as `setBy`, and an unregistered thread is
registered under the default name `planner`). It answers a project's delegated
questions when the asking task's own planner cannot, receives the project-level
notices that once went to the retired owner, and is the thread `to: {project}`
resolves to; it grants no verb, hold or acceptance authority. A task's planner is
recorded on the task itself — its submitting owner, or the thread its brief named
— and `helper reparent` moves it. `project.agents` lists the project's named,
non-task threads, and `agent.register`/`agent.unregister` maintain them (Spec 060).

## Review entry for external PRs

Treat "adopt this PR" or "queue this external PR" as a request to bring the named
external PR onto the board through [review entry](references/review-entry.md).
Review entry brings a finished external PR through the normal Nucleus gates. Do not
extend one PR's authorization to its siblings or to release/provider mutations.

## Planning records, papercuts and QA

For planning and lane documents, read [plan](references/plan.md); for writing,
approving and promoting briefs, read [brief](references/brief.md); for passing
planner ownership and notifications to a successor, read [handover](references/handover.md); for shaping
long-horizon direction with the operator, read [Atlas](references/atlas.md).
Repository knowledge and documentation structure remain in the Northstar skill.

- **Planner** owns the project's plan, lane documents, leads, briefs and
  dispatch approval. It runs milestone QA on `main` with `project.qa.run`.
  Anything that needs independent review goes through Nucleus as a brief.
- **Worker** implements one brief in the worktree Nucleus gives it, runs the
  covering checks, opens one PR, reports, and gets out of the way.
- **Reviewer** checks the exact head against the brief and reports findings. It
  does not run full `effigy qa`.

Coordination (recovery, review routing, merge, closeout) is Nucleus's job.

Papercuts, leads, decisions and plans are Nucleus records:
`papercut.add|list|get|edit|promote|promote-task|close|set-lanes`,
`lead.add|submit|edit|get|version|list|set-lanes|set-tags|drop|reopen|promote|check|approve|promote-task|import`,
`decision.add|get|list|answer|withdraw|link|supersede|backfill`, and `plan.get|plan.set`.
Record small recurring friction as a papercut and carry on; list existing items before filing duplicates. The planner can attach it to lanes, promote it, or close it as completed or deprecated.
A papercut needs `repository` (an origin string or `{origin, path}`), `title`,
`happened` and `impact`; `papercut.promote-task` also needs `complexity`, since
its generated brief has none.

```sh
node bin/queue-cli.mjs papercut.add - <<'JSON'
{"repository": {"origin": "owner/name", "path": "/abs/checkout"},
 "title": "...", "happened": "...", "impact": "..."}
JSON
```

A lead names complexity in its brief as
`queue.complexity`. A lead is checked at the pushed head and approved only
by the operator (or a relayed agent naming the authorization); promotion rechecks
planning, routing, dependencies and pre-dispatch policy before admitting one task
per approved lead version and repository. A newly checked and approved version
can admit after an earlier target was cancelled; it does not cancel or supersede
that target. Retrying an admitted version returns its own original task or outcome,
even if its check/head or metadata changed. Keep every historical target. Unknown
historical version binding refuses explicitly; do not clear targets or invent a
binding. After a lost reply, inspect the operation or source before retrying;
unresolved delivery must be observed first. Papercut edits retain their original
task and do not create a new admission.
Link decisions to related tasks, leads or papercuts. Withdraw an overtaken question, or supersede one that changes shape. Record a ruling given in chat with `decision.answer`, quoting the operator and naming them in the note; also land it in the owning knowledge file or close the question. Decisions record rulings only and grant no execution authority.

```sh
node bin/queue-cli.mjs decision.add - <<'JSON'
{"question": "...", "options": ["A", "B"],
 "recommendation": "A, because ...", "context": "..."}
JSON
```

Nucleus ties every board decision to a project and names who asked: the CLI
records the calling thread as the asker, derives the project (and the caller's
task link) from that identity, and refuses a decision it cannot place. Omit
`project` and `tasks` when asking about your own work; link related tasks,
leads or papercuts you are not placed on. A `project` that contradicts the
calling thread is refused, as is an asker Nucleus cannot place — the refusal
says to pass `project` or link the task. An operator adding a decision at the
board picks its project. Superseding names the superseding thread the same way:
a typed or inherited asker is never reused.

`queue.outcome-search`
answers "what landed for X" and "why does this code look like this" before reading
PRs; `queue.detail` reads one task and `queue.outcome` its permanent row.

Full QA runs at a milestone, not per task: `project.qa.run`
(`{repository, baseBranch}`) runs the repository's `qa` setting or `effigy qa` in
a Nucleus-owned linked worktree of the registered checkout, with setup and teardown
recorded as their own steps. `project.qa.get` and `project.qa.cancel` inspect and
cancel it, and `project.qa.dismiss { id, reason, caller }` clears a finished
failure from the board without deleting its record. A request refused with a diagnostic starting "QA request preparation
was interrupted" claimed no run; submit again with a new request ID only if the
milestone still needs one.
Add `wait: true`, or use `nucleus project.qa.run --wait -` with the same JSON,
to return the settled run in one call: `state`, `exitCode`, `failureIndexes` and
`failuresLogPath` (null when there are no consolidated failure diagnostics).
The path contains the retained `failuresLog` text. Waiting keeps the same run and
request ID and does not change admission; socket loss still needs reconciliation
with `project.qa.request-status` using the printed request ID.

On settlement, Nucleus messages the registered project planner and the known
submitting agent with the state, failed and cancelled counts, and run ID. A
non-TAP failure may have no test identities; inspect the failed step's retained
output path in `project.qa.get`. The recorded timeout is the scheduler envelope;
each step still uses its configured timeout, and staged envelopes include the
stage limits plus setup and teardown limits. Explicit QA limits win over
historical wall-time estimates; history does not lengthen the enforced limit.

**QA admission fence** (Tom, 2026-10-22): during a shared-tool install the
operator, or an agent relaying the operator's recorded ruling (`relayed: true`
plus the authorization `note`), can fence NEW project QA with
`project.qa.fence` (`action: "set"`, `expectedRevision`, `reason`, `minutes`
default 10, at most 120). It covers project QA only, never task validation or
Effigy client runs, and Nucleus has no per-task pause for those. Never set or
clear a fence without that authority. While a fence is in force a new
`project.qa.run` is refused with a diagnostic starting "QA admission is
fenced": that is expected, not a failure; retry after it expires or is
cleared. `project.qa.fence-status` reads the fence and the complete list of
unsettled QA. An install is QA-safe only while the same fence is in force and
that list is empty.

`backup.now`/`backup.list` make and list verified store snapshots. The
portable-record export/import and the shadow stream are retired; nothing
replaces them, and old exports stay inert history. See
[the orchestration contract](../../docs/knowledge/contracts/orchestration.md) and
[Spec 050](../../docs/knowledge/specs/050-owner-task-controls.md) for the exact
gates behind the verbs. Preserve the operator pause, profiles, limits and
subscription state; never reset an exhausted group.

### Worktree setup

Use `nucleus worktree prepare [SOURCE[=LINK] ...]` before repository setup,
`nucleus worktree link` after it, and `nucleus worktree unlink` on teardown.
The command replays the primary checkout’s Effigy dependency links. Sources are
resolved relative to the primary checkout. A primary checkout is left alone.
When Nucleus is not installed, a checkout can run `node /path/to/nucleus/bin/nucleus.mjs worktree <action>`; this needs no dependencies from the target worktree.

Create and edit routing profiles in Settings → Profiles.
