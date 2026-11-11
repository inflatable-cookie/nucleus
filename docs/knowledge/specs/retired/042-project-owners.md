# 042 — Project owner threads and dormant projects

Status: retired (2026-11-02, [Spec 058](../058-responsible-tasks.md) cutover 5). Project
ownership is not a standing role: authority comes from the operator at the board, a relayed
operator note, or a delegated ladder answer. The `owner` field, the owner acceptances and the
`project_owner` records stay readable on old rows; the assignment, claim, liveness checks and
Chatterbox inventory are deleted. Notices that fell back to the project owner follow the
project's planner (`project.set-planner`), then the Queue planner; a project with no planner
and no live owner record is dormant. This document is history.
Owner: Queue runtime and UI maintainers
Created: 2026-10-03
Decision owner: Tom
Governing refs: [Spec 041](../041-planning-roadmap.md) (drain prompts, next aim),
[Spec 027](../027-multi-repository-projects.md) (projects),
[Spec 040](../040-merge-hold-release-prompts.md) (owner prompts),
[Spec 058](../058-responsible-tasks.md) ("Project ownership retires")

## Problem

Spec 041 sent project prompts to "the agent that last saved the plan". Northstar
imported about 23 plans on 2026-09-27, so its thread received a next-aim notice for
every one of those projects when Spec 041 went live (2026-10-03). A thread's
responsibility is not its workspace's project either: Northstar also owns
`northstar-language-packs` (Tom, 2026-10-03).

## Rulings (Tom, 2026-10-03)

- A project has an explicit owner thread. A thread may own many projects.
- The operator assigns and reassigns owners. Any Chatterbox may claim a project
  through the CLI, owned or not. The claim is recorded and visible, and the operator
  can reassign. A project attached to one thread may be spun off into its own thread,
  so a claim is never blocked (Tom, 2026-10-03).
- A project with no owner thread, or whose owner thread no longer exists, is
  dormant: silent, and collapsed on the board and in Planning.

## Model

- `project.owner`: `{ agentId, assignedBy: "operator" | agent id, assignedAt, note }`
  or null. Methods: `project.assign-owner` (operator, any project, any live thread;
  `null` clears) and `project.claim` (`{project, note}`: the calling thread takes
  ownership, with a required note). A claim is always accepted, whoever owns the
  project. Both record an event, with the previous owner, and are visible in project
  detail. When ownership moves from a live thread, Queue sends that thread one notice
  naming the new owner, and pending prompts to it are superseded. A refreshed or
  spun-off Chatterbox claims its projects (Tom, 2026-10-03).
- **A new project owner takes the project's orphaned tasks** (Tom, 2026-10-26:
  "Orphaned + old owner's"). On a claim or an assignment to a thread, every open
  task of the project whose owner (Spec 040) is the previous project owner, a
  thread observed archived or missing, or the operator moves to the new owner in
  one transaction, each recorded as `owner_changed`. A task another live thread
  owns stays with it — a second planner sharing the project — and the result's
  `taskOwners` lists it as kept with its owner. Liveness is read before any write;
  a read that fails keeps the task. A new owner that cannot own tasks (not a live
  thread with a workspace, or a task's worker, reviewer or coordinator) still
  takes the project, moves no task and returns the reason in `taskOwners.refusal`.
  Clearing the owner moves nothing.
- **Dormant** is derived: no owner, or the owner thread is reported missing (Paseo
  "Agent was not found") on the last check. Queue re-checks owner liveness at most
  hourly and on assignment. A dormant project's record keeps its owner so the
  operator sees who it was.
- **Routing.** Every project-level prompt goes to the project owner: Spec 041 lane
  close-out and next-aim notices, and later project-level notices. Plan authorship no
  longer decides routing. Task-level routing (origin, coordinators, completion
  cohorts) is unchanged.
- **Dormant behaviour.** No drain episodes, prompts or escalations. Tasks already
  dispatched in a dormant project keep running. A project that becomes owned starts
  fresh, with no backfilled episodes.
- **Seeds.** At migration: Queue `bc18b750` → paseo-northstar-queue; Effigy
  `58c8685e` → effigy, effigy-catalog-pack; Project-a `32addc32` → project-a-accelerator;
  Project-d `87281446` → project-d; consumer-b `26fb4dc9` → consumer-b-v2; Northstar
  `d24445ee` → northstar, northstar-language-packs. Every other project starts
  dormant; seeds record `assignedBy: "operator"` with the note "Spec 042 seed".

## Board and Planning

- Owned projects show their owner thread's name. Dormant projects collapse into a
  "Dormant projects" group in the board scope and the Planning tab, each with
  Assign owner (a picker over live Paseo threads).
- Project settings show owner, assigned by, and when, with Assign, Reassign and Clear.
- Dark theme only when checked by eye.

## Acceptance

| # | Case | Expected |
|---|---|---|
| 1 | Owned project's lane drains | Prompt goes to the owner thread, not the plan's last saver |
| 2 | Project with no owner | No episode, prompt or escalation; shows under Dormant |
| 3 | Owner thread missing | Project turns dormant on the next liveness check; pending prompts superseded |
| 4 | `project.claim` on an ownerless project | Recorded with the claimer and note; prompts route to it |
| 5 | `project.claim` on a project another live thread owns | Accepted; previous owner recorded and notified once; its pending prompts superseded |
| 6 | Operator assigns or reassigns | Recorded; routing follows; pending prompts to the old owner are superseded |
| 7 | One thread owns two projects | Both route to it |
| 8 | Migration | Seeds applied; others dormant |
| 9 | `project.claim` on a project whose owner thread is gone | Accepted at once; no notice to the gone thread |
| 10 | Claim or assignment with open tasks | The previous owner's, archived or missing threads' and operator-owned open tasks move to the new owner; another live thread's tasks stay and are listed as kept |
| 11 | New owner cannot own tasks | Project owner recorded; no task moves; `taskOwners.refusal` names why |
