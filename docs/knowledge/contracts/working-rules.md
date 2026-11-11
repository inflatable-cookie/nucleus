# Working rules

Owner: Nucleus maintainers

Work reaches this repository as Nucleus tasks. The planner writes a brief (or, for
tasks submitted before the lean cutover, a committed handoff), Nucleus dispatches a
worker, an independent reviewer checks the exact head, and Nucleus merges and
closes the task out. Intent lives in Nucleus's plan (lanes, lane documents and their
order); leads, tasks, briefs, status and outcomes live in Nucleus too, never in
this repository. A lead is not execution authority. Board observations and
triage notes are not a backlog to invent from (2026-09-16).

The planner owns operator intake, planning rulings and plan and knowledge
updates. The plugin owns mechanical task management. Workers do not spawn
replacement orchestration planes or merge their own PRs. A blocker is the
worker's to own, with the retained reviewer as its second opinion and the
Spec 058 planner ladder beyond that; only operator-only kinds reach Tom.
Removing a blocked task is not a resolution.

Nucleus-side defects are diagnosed against code and promoted to concrete fixes;
an existing supported recovery may settle an observation. Capacity, settings,
global-limit changes and peer planning authority remain Tom's (Tom, 2026-10-06).

## No stages

The declared steps execution system is retired (Tom, 2026-10-06). Execution is
worker, one independent exact-head completion review, merge and archive.
Historical stage declarations, callbacks, checkpoints and signed outputs remain
evidence, never merge authority. Old stage controls no longer execute, and new
briefs or amendments cannot opt into stages (Spec 043).

Nucleus must not create preparation or review churn to satisfy its own state
model. Incomplete reviewer coverage belongs to that authenticated reviewer, not
to an author revision. Disposable test evidence is never live consumer
authority, and workers never fabricate receipts, rewrite old callbacks or issue
live consumer controls to reach readiness.

## Change rules

Ready work states its boundary, acceptance proof and stop conditions. Changes
crossing persistence, concurrency, identity or public API boundaries need an
adversarial counterexample and the expected safe failure. A change that alters
what is true updates the owning knowledge file in the same PR.

A gate names the fact it protects and checks that fact (Tom, 2026-09-24).
A stored field, message string or a record's existence is evidence, not the
fact, once the two can come apart. Gate on the live check and keep the field
for identity. Match messages by structured cause, never by prefix. A refusal
needs an exit that can make its condition false; existence of a run,
completion or hold is not the thing's role or status.

Small planning edits (plan, spec or contract wording) are committed straight to
`main` once `effigy qa:docs` passes; code and anything needing review goes
through a Nucleus task and its PR. Briefs start as checked, approved leads. Never
edit a submitted handoff: clarify in the owning spec, or resubmit and supersede
the task.

Record recurring solvable friction as a Nucleus papercut (`papercut.add`) without
making it an unplanned implementation task. Validate through Effigy; keep npm
scripts for existing package-native commands. Node remains the runtime for the
Paseo SDK, SQLite and reporting bridge. No CI or release mutations are implied
by routine work.

## Automatic review loops retired

Spec 037's budget-free publication continuations and Spec 044's automatic
reviewer turns are retired (Tom, 2026-10-07). Findings and checkpoints remain
evidence; unfinished reading never goes back to the author. Further reviewer
turns require explicit operator authorization. Ordinary author defects use the
bounded revision budget. Pause, holds and authentic exact-head approval remain
required.

## Project-a completion after retirement

The Project-a owner may convert unfinished Project-a tasks to plain completion briefs
and release their dispatch holds in dependency order (Tom, 2026-10-07),
preserving task, PR and workspace identity, completed work, review history and
source, rights and publication obligations; completed signing is not replayed.
Nucleus handles operational blockers; Project-a owns substantive scope. Unfinished
reviewer coverage is saved evidence requiring owner action, never an automatic
new turn or author no-op. This restores no steps, publication loops or reviewer
continuations and authorizes no preparation chains, gate waivers, profile or
capacity changes, database edits or daemon restarts.
