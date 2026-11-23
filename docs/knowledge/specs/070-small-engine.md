# Spec 070 — A small task engine, in Rust

Status: approved (Tom, 2026-11-23: "Approve, let's get this working."). It is built
alongside the current engine, switched on for new tasks, and the old engine is
deleted once its tasks drain.
Replaces the control plane of Specs 050, 066, 067 and 068. Spec 069's lesson stays:
cost grows with active work only.
Audience: engine implementers, reviewers and planners

## Outcome

Tom, 2026-11-23: "The mechanics of tasks are STILL too fiddly, too brittle, too
finicky for agents to manage. We've GOT TO get on top of this." And, on the first
proposal (one escape command): "it feels like the mechanics are fundamentally too
complicated - you're suggesting yet another band aid to a problem that needs a
chainsaw taking to it."

On 2026-11-23 the engine was 283,000 lines of production TypeScript. A task record
had 108 top-level fields plus 72 more in its resolution block, and there were 554
event kinds. A stuck task could be held at once by stops, waits, incidents,
escalations, recovery episodes, effects, run pointers and coordinator bindings. Each
had its own clear command, ID and refusals. On the same day, a brief timeout took
four commands to clear (nucleus#1560), and one task had no command at all, because
every route led into the same proof-gated launch (praxis#391).

The new engine:

- **Stores almost nothing.** It reads the world fresh on every pass.
- **Decides with one pure table.**
- **Recovers mechanical faults itself.**
- **Asks a person only about the work.**

An agent can't get a task stuck in a way that `move` can't undo.

## Rulings

Tom approved all of these on 2026-11-23 ("Approve, let's get this working."):

1. **The recovery coordinator role is retired.** Code handles mechanical faults. This
   replaces the AGENTS.md product rule "one retained recovery thread handles
   operational faults" when the new engine is switched on.
2. **The planner ladder collapses.** A task's question goes straight to its planner.
   The worker → reviewer → planner rungs, the blocker classification and the ladder
   records go.
3. **Build alongside and switch over.** Don't refactor in place. The old engine gets
   only fixes that unblock live tasks until its tasks drain. Then it is deleted.
4. **The new engine is Rust.** The web board UI stays TypeScript and reads the
   engine's JSON API. The existing board is the basis, not a constraint (Tom: "It
   can reuse the UI we've built - it's not perfect, but it's about 85% of the way
   there", then "it shouldn't just reuse the current UI as is - the basis is good,
   adapt it to the new model though, not adapt the model to the ui!!"). The model
   and API come from this spec alone. The board keeps its layout, theming and
   primitives, and its components are reshaped to the new model. Components that
   exist only for the old machinery are deleted. T3 is called directly over its RPC.
5. **T3 is the only host.** BB and Paseo are dropped, not ported (Tom, 2026-11-23: "Regarding BB and Paseo - I wouldn't be upset if we drop them. I like T3, the workflow can work well.. I'd be tempted to not bother with those two. If I was going to support more ADEs, I would look at something like Zeron, which would get a similar integration to T3."). The host trait stays, so a future ADE gets an adapter shaped like T3's.
6. **The ACP task session is a core component.** Tom, 2026-11-23: "Is the fake ACP provider part of the T3 integration? That part would be what unlocks supporting other ADEs with the same workflow so it needs to be a core component". This carries over the 2026-11-17 decision 5e9a3193 behind [Spec 065](065-acp-task-session.md): a generic ACP agent in core, with parenting per host. Nucleus is an Agent Client Protocol agent over stdio with no model. Each task is one ACP session, which is one thread in any ACP-capable ADE. The session presents the task's phase, current run, wait and question, and it carries the five commands. A host adapter adds only how that host parents the worker and reviewer under the session. The ACP agent knows nothing about T3. Workers and reviewers are never top-level threads. They are child threads under the task's ACP session, as in the TypeScript engine. Tom, 2026-11-23: "when I said no worker or reviewer threads, I meant top-level.. it should work with the ACP the way the TS version does now". A person sees one row per task, and each run appears inside it as that session's `tool_call` (ruling 7).
7. **The ACP session is written for a person.** Tom, 2026-11-23: "I would like the Nucleus ACP to be much more human friendly than it is now - provide actual useful feedback about the task as things happen, avoid too much noise, make it obvious what each sub agent is doing." The rules:
   - The lifecycle is one ACP `plan`: Queued, Working, Review (round N), Merge and Close. Each step is pending, in progress or done. A wait shows as that step's status (for example, "Waiting for a review slot"). Waits are never messages.
   - Each worker or reviewer run is one `tool_call`, titled with its role and what it's doing ("Worker: adding the retry test", "Reviewer: checking round 2"). It's updated in place with the agent's current activity and elapsed time, drawn from the observed turn: the running command, a file being edited or tests running.
   - Messages appear only for things a person would want to read: the PR opened (with its link), a review verdict and its findings in a sentence or two, a merge, a question for the planner, and the finish with a short summary.
   - No noise. Retries, timeouts, deferrals, unknown reads and repeated identical states produce nothing. A state that persists becomes a status change, shown once.
8. **The settings carry over.** Tom, 2026-11-23: "we need to make sure the vast majority of the settings view comes over - all the profile management, limits, projects, etc need to transition over.. adapted to the new model". Profiles and model selection, dispatch limits (slots, load, budgets and usage levels), projects (repositories, planners and lanes), storage and host settings are part of milestone 2. They're reshaped to the new model: settings for machinery that no longer exists are dropped.
9. **The profile matrix carries over exactly.** Tom, 2026-11-23: "The profile matrix we agreed earlier definitely needs to come over, we've finally got that working just as I want it". The usage-level matrices in [Spec 052](052-usage-level.md), as amended on 2026-11-23, are ported cell for cell. That covers worker start brackets by complexity and level, the reviewer bracket relative to the worker, the step-up after an applied changes-required review, the smoothed Maximum, the Frontier request rule and critical tasks. So is [Spec 053](053-demand-based-selection.md)'s demand-based selection (the five-stop weight slider). They become pure functions with a test for every cell of both matrices, matching today's `test/demand.test.ts`. The only change is that the retired coordinator role drops out. A climb to a new profile starts a new worker child thread, as the TypeScript engine does. Tom, 2026-11-23: "The current TS policy of creating a new child thread is correct, we won't be able to switch profiles in the same thread when they have different providers".
10. **Reuse in-house crates.** Use Longhorn for configuration and anything else that
   fits (Tom: "use longhorn for config and anything else you think would be
   useful"). Barge provides worktrees when its pool setting is on.
11. **Keep it light: reads and edits never call the host.** Tom, 2026-11-23: "We need to keep things light and optimised - remember to treat CRUD operations separately from scheduler interactions with the host and to avoid hammering the host with calls". The rules:
   - Board, ACP, CLI and settings reads and edits (create, read, update, delete) touch only the store and the in-memory read model. They never call T3, GitHub or the process census. A command writes its row and wakes the task, and the scheduler does any host work on its next pass.
   - Only the scheduler talks to hosts. Each pass makes one bounded set of host reads per host, shared by every task in that pass (for example, one thread listing rather than a read per task). It reads one thread or PR exactly only when a due decision needs it.
   - Host calls have a fixed concurrency cap per host. An unavailable host backs off to a due time and is never retried in a loop.
   - Views update by push (task and version invalidations), never by polling. Nothing a viewer does causes a host call.

## The model

### Stored state per task

| Field | Meaning |
|---|---|
| `id`, `reference`, `repository`, `base`, `entry`, `origin_thread` | Identity fixed at admission. Entry is `brief` or `review_entry`. The submitting or promoting thread is the origin when the caller has one. |
| `brief` | The brief text, its version and digest. |
| `phase` | `queued`, `working`, `reviewing`, `merging`, `closing`, `done` or `cancelled`. |
| `threads` | Retained worker and reviewer thread IDs and a monotonic launch sequence. Reuse each role's thread when it is idle. Replace its ID when the host confirms the thread is gone, or when the role's profile changes (ruling 9): a profile climb starts a new child thread, because one thread cannot change provider. |
| `run` | The current role, thread ID, credential digest, label, start time and launch instance. It holds the immutable launch request, the last possible send time and at most one authenticated report. A revoked run stays bound until the engine observes it quiescent, even after cancellation. |
| `pr` | URL and head SHA. |
| `verdict` | The reviewer's verdict at a given head: `approve` or `changes`, with its summary. A verdict at any other head is history. |
| `attempts` | Failed launches or silent ends at the current phase and head. The first observed PR starts a fresh count. |
| `question` | At most one open question to the task's planner, with its options and the head it was asked at. Observing a new head clears it. |
| `hold` | An optional operator or planner hold, with its reason. |

Anything else is observed, never stored as a record that something must clear.
History is an append-only event log for display and audit only. The engine never
reads its own events to decide anything.

### Observations

Each pass reads, for active tasks only:

- **Host:** for the exact run's thread, whether it exists, its turn state (running,
  idle or ended), the report if one was sent, and pending permission or user input.
  On local T3, settlement also checks for processes using that checkout.
- **Forge:** the PR's state, head, mergeability and checks, and whether it was merged
  and at which commit.
- **Workspace:** whether it exists, its head, and whether it is clean.

A read that fails is `unknown`. Unknown never releases, never terminates and never
counts as idle. The engine just decides again on the next pass.

### The decision table

A pure function, `decide(task, observation) -> Action`, written as one exhaustive
`match` on `(phase, run state, observation)`. The actions are:

- `Launch(role)`
- `Wait(reason, next_check)`
- `Advance(phase)`
- `Merge`
- `Close`
- `Relaunch(role)`
- `Ask(question)`
- `Nothing`

Every action is idempotent:

- Launches and sends use a deterministic label, `task-{id}-{phase}-{head}-{attempt}`.
  The task assigns each reservation a distinct launch instance and bearer. Revisiting
  the same phase and head after `move` uses new native command and message IDs.
  Only the current reservation can be replayed. An unrevoked replay can start
  work. A revoked replay only reconciles uncertain delivery and stops the turn.
- Before any send, the engine reads the exact native thread and message identity.
  It records the possible send before writing. If a reply remains unknown, it
  waits out the host's late-reply window and replays the identical request under
  the same command ID. An unsent revoked reservation clears directly.
- A merge is the guarded GitHub merge at the exact head.

### Faults

- **A run that's gone, or that ended without reporting**, is relaunched in the same
  role, and `attempts` goes up.
- **Three failed attempts** at the same phase and head end in one question to the
  planner.
- **Timeouts, deferrals, unreadable state and uncertain launches** are not faults.
  The engine waits and looks again on the next pass.
- A prepared review can send only with a fresh clean checkout at the open PR's
  exact head. A reservation that no longer fits proceeds to reconciliation
  without charging a failed attempt. A failed attempt counts only when the
  required head observation is known.
- If the head moved while delivery was uncertain, reconciliation can replay the
  old request after revoking its credential. It stops the exact turn and archives
  the thread before clearing the run. The old review cannot report a verdict.
- **A task needs a person only when the question is about the work itself.**

### Commands

| Command | Effect |
|---|---|
| `move to=<phase>` | Ends any live run (revokes its credential, stops its turn), clears `attempts` and `question`, and sets the phase. Always applies, apart from the two gates. |
| `answer` | Answers the open question. Work guidance becomes a new brief version, retry clears the capped count, and authorized acceptance binds to the exact observed head. |
| `cancel` | Ends any live run and sets `cancelled`. Leaves the worktree if it is dirty. |
| `amend` | Replaces the brief and records the new version. |
| `hold` / `release` | Pause or unpause one task. |

There are no other control verbs, explicit commands, record kinds or warnings to
accept. `next` shows the phase, what the engine is waiting on, the open question and
the commands above.

### Hard gates

There are only two:

1. **Merging needs an exact-head `approve` verdict, or a recorded acceptance of that
   head.** The task's planner can accept an externally merged, unreviewed `brief`
   task (Tom, 2026-11-23). For a `review_entry`, only the operator can accept it.
2. **A worktree with uncommitted work is never deleted.**

## Engine shape

A Cargo workspace inside this repository, at `engine/`:

| Crate | Role |
|---|---|
| `nucleus-core` | Types, the decision table and the state transitions. No I/O. |
| `nucleus-store` | SQLite for tasks and the event log, through a small schema of its own. |
| `nucleus-hosts` | The host trait and the T3 adapter. No BB or Paseo adapters (ruling 5). |
| `nucleus-forge` | GitHub: the PR, checks, merge at the exact head, and reviews. |
| `nucleus-work` | Worktrees under `workRoot`, or from a Barge pool when the setting is on. |
| `nucleus-acp` | The host-neutral ACP agent (stdio JSON-RPC): one session per task, presenting its state and carrying the five commands. A thin client of the service (ruling 6). |
| `nucleus-service` | The pass loop, the JSON API for the board and the ACP agent, and callbacks. |
| `nucleus-cli` | The `nucleus` command. |

Reuse, to be confirmed by the build when it reads their contracts:

- **Longhorn:**
  - `longhorn-config` for settings and the Storage page values (versioned domains,
    atomic writes, backups);
  - `longhorn-storage-layout` for roots;
  - `longhorn-git-workspace` for git operations;
  - `longhorn-operation` for action lifecycle, if it fits idempotent labels;
  - `longhorn-support-log` and `longhorn-redact` for logs;
  - `longhorn-update-install` for installing a verified build on roll.
  - Use the exact Longhorn worktree-identity API. Tom's interim pin (relayed
    2026-11-23) is `rev = "049392e27f93d642839b82c28d217c1f353e569e"` until
    the `v0.6.0` tag is available.
- **Barge:** the storage library and the worktree lease contract (lease, return, run).
- **Toolchain:** the rs-toolchain gates (clippy, rustfmt, nextest, cargo-deny), run
  through Effigy.

## Validation

Tom approved Rust for the engine on 2026-11-23. That replaces the 2026-10-04 "no
Cargo builds" rule for the `engine/` workspace only:

- **Each change:** `cargo check`, clippy, and nextest of the affected crates.
- **Milestone QA:** runs the whole workspace.
- **Shared build cache:** builds share one target directory or sccache, so parallel
  workers don't rebuild the world.

## Migration

1. **Milestone 1:** one task runs work → review → merge → close through the new engine
   on T3, behind a setting, and is checked by hand. Tom, 2026-11-23: "Yes, you can
   create a throwaway repo on inflatable-cookie". The live proof uses the private,
   synthetic `inflatable-cookie/nucleus-fixture` repository and its own T3 project.
   For this proof only, the engine uses standalone top-level role threads and its default
   worktree allocator. Milestone 2 parents them under the task's ACP session (ruling 6).
2. **Milestone 2:** the board reads the new engine's API, and its settings (profiles, limits, projects, storage) work against the new engine (ruling 8). New tasks for one project go
   to the new engine. Tasks are presented through the core ACP session (ruling 6), one row per task, before the first real project.
3. **Milestone 3:** new tasks for every project go to the new engine. The old engine
   takes no new work.
4. **Milestone 4:** once the old engine's tasks drain, it is deleted. AGENTS.md, the
   skill and the contracts are rewritten for the new commands.

A task never moves between engines.

## Out of scope until milestone 3

- Papercuts, leads, decisions, plans and milestone QA records keep their current
  store and CLI. The engine reads leads only to admit a promoted task.
- Usage levels, model selection and budgets carry over as plain settings, not as new
  state. They're part of milestone 2's settings (ruling 8).
