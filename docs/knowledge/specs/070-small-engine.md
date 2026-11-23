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
   exist only for the old machinery are deleted. Host plugins that must be JavaScript (Paseo, BB) become thin
   shims. T3 is called directly over its RPC.
5. **Reuse in-house crates.** Use Longhorn for configuration and anything else that
   fits (Tom: "use longhorn for config and anything else you think would be
   useful"). Barge provides worktrees when its pool setting is on.

## The model

### Stored state per task

| Field | Meaning |
|---|---|
| `id`, `reference`, `repository`, `base` | Identity. |
| `brief` | The brief text, its version and digest. |
| `phase` | `queued`, `working`, `reviewing`, `merging`, `closing`, `done` or `cancelled`. |
| `run` | The current run: role (`worker` or `reviewer`), thread ID, credential, label and start time. Absent when no run is live. |
| `pr` | URL and head SHA. |
| `verdict` | The reviewer's verdict at a given head: `approve` or `changes`, with its summary. A verdict at any other head is history. |
| `attempts` | Failed launches or silent ends at the current phase and head. |
| `question` | At most one open question to the task's planner, with its options. |
| `hold` | An optional operator or planner hold, with its reason. |

Anything else is observed, never stored as a record that something must clear.
History is an append-only event log for display and audit only. The engine never
reads its own events to decide anything.

### Observations

Each pass reads, for active tasks only:

- **Host:** for the run's thread, whether it exists, its turn state (running, idle or
  ended), the report if one was sent, and pending permission or user input.
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
- Before any create, the engine looks up the label. An unknown outcome is simply
  looked up on the next pass. Nothing is ever resent blindly.
- A merge is the guarded GitHub merge at the exact head.

### Faults

- **A run that's gone, or that ended without reporting**, is relaunched in the same
  role, and `attempts` goes up.
- **Three failed attempts** at the same phase and head end in one question to the
  planner.
- **Timeouts, deferrals, unreadable state and uncertain launches** are not faults.
  The engine waits and looks again on the next pass.
- **A task needs a person only when the question is about the work itself.**

### Commands

| Command | Effect |
|---|---|
| `move to=<phase>` | Ends any live run (revokes its credential, stops its turn), clears `attempts` and `question`, and sets the phase. Always applies, apart from the two gates. |
| `answer` | Answers the open question. |
| `cancel` | Ends any live run and sets `cancelled`. Leaves the worktree if it is dirty. |
| `amend` | Replaces the brief and records the new version. |
| `hold` / `release` | Pause or unpause one task. |

There are no other control verbs, explicit commands, record kinds or warnings to
accept. `next` shows the phase, what the engine is waiting on, the open question and
the commands above.

### Hard gates

There are only two:

1. **Merging needs an exact-head `approve` verdict, or a recorded acceptance of that
   head.** For an externally merged, unreviewed PR, the task's planner can accept it
   (Tom, 2026-11-23). For a never-dispatched review entry, only the operator can.
2. **A worktree with uncommitted work is never deleted.**

## Engine shape

A Cargo workspace inside this repository, at `engine/`:

| Crate | Role |
|---|---|
| `nucleus-core` | Types, the decision table and the state transitions. No I/O. |
| `nucleus-store` | SQLite for tasks and the event log, through a small schema of its own. |
| `nucleus-hosts` | The host trait and the T3 adapter first. BB and Paseo follow as shims. |
| `nucleus-forge` | GitHub: the PR, checks, merge at the exact head, and reviews. |
| `nucleus-work` | Worktrees under `workRoot`, or from a Barge pool when the setting is on. |
| `nucleus-service` | The pass loop, the JSON API for the board, and callbacks. |
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
   on T3, behind a setting, and is checked by hand.
2. **Milestone 2:** the board reads the new engine's API. New tasks for one project go
   to the new engine.
3. **Milestone 3:** new tasks for every project go to the new engine. The old engine
   takes no new work.
4. **Milestone 4:** once the old engine's tasks drain, it is deleted. AGENTS.md, the
   skill and the contracts are rewritten for the new commands.

A task never moves between engines.

## Out of scope until milestone 3

- Papercuts, leads, decisions, plans and milestone QA records keep their current
  store and CLI. The engine reads leads only to admit a promoted task.
- Usage levels, model selection and budgets carry over as plain settings, not as new
  state.
