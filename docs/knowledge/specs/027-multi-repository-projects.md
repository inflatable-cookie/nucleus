# 027 — Multi-repository projects

Status: implemented
Owner: Nucleus runtime and UI maintainers
Created: 2026-09-26
Decision owner: Tom
Governing refs: nucleus `docs/knowledge/contracts/002-core-requirements.md#projects-and-repositories`
(main e257881), [Spec 021](021-task-numbers.md) (task numbers),
[Spec 022](022-queue-projects-without-manifests.md) (per-repository settings),
[Spec 026](026-planning-records.md) (per-project lane order, board scope).
Nucleus piloted this for the separate retired Nucleus system.

## Problem

Nucleus treats each repository as a project. Real projects span several:
Consumer-app is `consumer-app` plus `consumer-library`, and consumer-b works with
`project-a-accelerator`. The project filter, the board and Spec 026's lane order
should follow the project, and a worker changing one repository often needs to
read its siblings. Today it has only the operator's checkouts to look at, or
nothing.

## Projects

- **Record:** a permanent, host-neutral `projects` record with a name, a unique
  key, and a list of one or more repositories (normalised origin, local path as a
  hint). A repository belongs to exactly one project. Every project has one
  primary repository; the others are secondary attachments, and tasks may target
  any of them (Tom, 2026-09-26; added by g01.070).
  The primary is the project's default repository: it names a default project,
  leads the project's repository list, and is the default for project-scoped
  views and the project plan. Repositories attach from
  arbitrary paths: each carries its own local path, they need not share a parent
  folder, and nothing derives membership from a folder layout (Tom, 2026-09-26).
- **Default:** every repository without an explicit project is its own
  single-repository project, named after the repository. Nothing changes for it.
  Moving a repository into a named project leaves its tasks, numbers, outcomes,
  lanes and settings where they are, because all of them key on the repository.
- **Primary selection:** `project.upsert` requires `primary` when several
  repositories are listed. A single-repository project defaults to its member.
  `primary` must name a listed repository. Existing defaults gain their sole
  member as primary; existing named projects gain their first listed member.
  Upsert returns the primary first. Removing the primary requires naming a
  replacement in the same upsert.
- **Tasks:** a task changes exactly one repository, which must belong to its
  project (Tom, 2026-09-26). Worktree, branch, PR, exact-head review and merge
  stay one-to-one. Cross-repository work is linked tasks with dependencies,
  usually in a lane. Task numbers stay per repository, shown as `repo#N` in a
  multi-repository project and `#N` in a single-repository one.
- **Scope:** the board's project filter, the per-project board and Spec 026's
  lane order key on the project, not the repository. A project's plan orders the
  lanes that list any of its repositories.
- **Operations:** `project.upsert` (name, key, repositories, primary), `project.get` (by
  key or by any member repository), `projects`, `project.settings` (one Settings
  read of projects, repository rows, slots, planner liveness and latest QA),
  `project.owner-candidates` (live threads with a `kind` so planners stand apart
  from task threads), and `project.remove` (delete by key
  and version, with a reason). Removing a repository from a
  project returns it to its default single-repository project.
- **Settings → Projects (lane `nucleus-ui`, task 946).** The section lists
  projects from `project.settings`, one row each with its status and one problem
  icon. Add project writes `project.upsert` on Create, with a key derived from
  the name and `create: true`, which the store refuses inside its write
  transaction when the key exists, so a stale list never rewrites another
  project. It offers only repositories still in their default project, since
  the store refuses one already in a named project. Defaults at the foot of the
  list holds the Nucleus-wide validation policy; the Repositories section is
  gone, and per-repository overrides live in the opened project. Dispatch limits
  keeps a list of projects with explicit slot overrides, with edit and remove
  actions; it shows only set overrides. The opened project's Slots field edits
  that same value, and clearing it restores inheritance and removes the Limits
  row. In-flight is always twice Slots and has no separate field.
  Opening a project edits its name, planner (`project.set-planner` as the
  operator), Slots (the same per-project override the Dispatch limits list
  shows; empty inherits) and park state, and each repository's operator
  settings through `repository.set`: validation policy, milestone QA command,
  timeout and schedule, checks policy, reviewer login and merge check. QA
  stages, output caps, termination grace, the schedule's interval ceiling,
  closeout, scratch namespace and note stay CLI-only and are kept as they are.
  The opened project's trash icon opens Remove (see "Project management"
  below). Park, Unpark and Delete are no longer in Planning's plan header, and
  the board's project selector only scopes: its settings icon opens Settings at
  Projects through a section hint on `openSettings`.
- **Naming.** Spec 022's per-repository rows are repository settings (closeout
  override, validation command), not projects. Their operations become
  `repository.get`, `repository.set` and `repositories`. The old `project.get`,
  `project.set` and `projects` names switch to the new record in the same change;
  a call in the old repository-settings shape is refused with a message naming
  `repository.set` or `repository.get`, so no caller silently writes the wrong
  record.

## Parking (Tom, 2026-09-27)

Source: nucleus contract 002 "Projects and repositories" (Parking) and contract 006
"Direction" (nucleus be70741). "Parked", not "shelved".

- **Visibility.** A project record has `visibility`: `active` (default) or
  `parked`. It's separate from archive and retention, versioned and host-neutral.
  `project.park` and `project.unpark` are operator commands, idempotent and
  version-checked.
- **Parking only hides.** Tasks keep running and dispatching; threads are never
  archived; workspaces, lanes, plans, leads, papercuts and drafts are untouched.
  Unparking restores the project exactly.
- **Attention always shows.** Holds, blocked tasks, drafts awaiting approval and
  findings from a parked project still reach every attention surface (Nucleus's
  attention notices and the board's attention states), marked "parked".
- **Paseo's sidebar is out of reach.** The Paseo daemon API offers no project
  visibility; `removeProject` would also remove workspaces. Parking lives in
  the retired system's views; Nucleus relies on its own sidebar for the full experience.

## Removal (Tom, 2026-09-30)

- **Delete, not hide.** `project.remove {key, version, reason}` is operator-only
  and version-checked. It deletes a project record for good, so a stale or
  duplicate project — for example one left behind by a repository moving to
  another org — stops appearing anywhere. Parking stays the way to hide a
  project that is still wanted.
- **Anything still in use blocks it.** The refusal names every blocker: a task
  that is not done or cancelled, an open lead, papercut or decision, an active
  lane, and a pending submission. The board's Delete action, offered on parked
  projects only, reads the same blockers from Nucleus's own scan
  (`project.removal-blockers`) for its confirmation, never a recomputed board
  view.
- **One repository out of a project (nucleus#967, Tom 2026-11-09).** Settings →
  Projects → a repository's ✕ offers **Separate project** (a `project.upsert`
  without it, so it becomes its own one-repository project) or **Remove from
  Nucleus**. The second is `project.remove-repository {key, version, repository,
  reason}`: one transaction that takes the member out and deletes the project
  it would become, with the same blockers, history and tombstone as
  `project.remove`. A blocker, a stale version or the primary refuses it whole,
  so it never leaves the repository split off but not removed. The choice stays
  disabled while `project.removal-blockers {key, repository}` names anything for
  that member, worded as the refusal words it.
- **Move a project into another (nucleus#969, Tom 2026-11-09).** Settings →
  Projects → an opened project → **Move into** picks a target; Add repository
  also offers repositories of other projects. Both are `project.merge {source,
  target, versions: {source, target}, repository?, reason}`: one transaction that
  moves every member (or the one named), keeps the target's name, planner, plan,
  slots and primary, and removes a source left empty with a tombstone, dropping its
  planner and slot override; an implicit `repo-<hash>` source is absorbed as
  `project.upsert` absorbs it.
- **A move carries its records (nucleus#984, Tom 2026-11-09).** Tasks, leads,
  papercuts, lanes, drafts, submissions, decisions and QA history attach to
  repositories, so they follow the moving repositories to the target unchanged
  and never block a move. A removed source's saved plan entries join the end of
  the target's plan in the same transaction; the target's idle mark stays only
  while no now or next lane joins. Only state that can't change projects
  mid-flight refuses the move: a queued or running project QA, or an in-flight
  repository re-key, on a moving repository. `project.merge-check {source,
  repository?}` returns those `blockers` and the `carried` records (as
  `project.removal-blockers` names them); the UI disables the move on blockers
  with the removal wording and its confirm counts what comes along. Removal
  keeps every blocker above. Moving one member of several needs it not to be
  that project's primary. A move that would leave a repository in two projects is
  refused. Remove from Nucleus names any other project that also holds the
  repository, because it is deleted too.
- **History stays.** Outcomes, closed leads, events and task numbers keep their
  repository identity and still resolve for search and export. The project's
  `repository_settings` row is removed only when no other project uses that
  repository. The project's own plan rows go with it, because a plan keys on the
  project key.
- **A tombstone keeps it gone.** Deletion writes `{key, repositories, reason,
  removedAt}` beside the submission tombstones: nothing restores a tombstoned
  project, and the retired export (Spec 029) never carried one.
- **Nothing else moves.** Removal never touches Paseo workspaces, checkouts or git
  state.

## Sibling context

- **By default,** a task's workspace comes with a separate worktree of each of the
  project's other repositories, checked out detached at `origin/<base>` as fetched
  at task start, created from each sibling's own recorded checkout. They are
  Nucleus-owned worktrees under the Nucleus data directory
  (`siblings/<taskId>/<repository name>`), never the operator's checkouts, and
  their paths are given in the worker, revision and reviewer prompts.
- **Pinned:** each run records every sibling's repository and commit, as it
  records the brief version, and the outcome row keeps them.
- **Read-only by rule,** not by filesystem permission. The prompt says so.
- **Changes are findings.** At each completion Nucleus compares every sibling
  worktree with its recorded commit. Any change (a moved head, a commit, or dirty
  files) is recorded as a sibling-change finding in task detail and given to the
  reviewer; it is never merged or pushed. The fix for a real change is a linked
  task in the sibling's repository.
- **Opt-out:** a brief or handoff sets `queue.siblings: false` to skip them.
- **Cleanup** removes sibling worktrees with the task's own, through the same
  retention and disposition paths, and never touches the operator's checkouts.
- **Relative paths:** a repository that refers to a sibling as `../name` does not
  find these worktrees, because Paseo places the task worktree. Repositories keep
  using their existing link tasks (for example Effigy `deps link`) for build-time
  links. Nucleus fast-forwards those worktree-root clones when they are clean and
  detached ([Spec 028](028-fresh-sibling-checkouts.md)). Nucleus, which owns its
  workspace layout, can place siblings beside the
  task worktree instead. Nucleus does not build container workspaces to fix this:
  taking worktree ownership from Paseo was declined (Tom, 2026-09-26), and
  Nucleus owns that layout.

## Tasks and order

1. **g01.062, projects:** the record, defaults, repository-settings rename,
   project-scoped filter and lane-order key. After g01.058; g01.059 now follows it
   so its plans key on the project.
2. **g01.063, sibling worktrees:** creation, pinning, change findings, opt-out and
   cleanup. After g01.062, in parallel with the Spec 026 tasks.

## Acceptance oracle

| # | Scenario | Required result |
| --- | --- | --- |
| 1 | Existing store migrated | Every repository is its own single-repository project; tasks, numbers, outcomes, lanes and settings unchanged |
| 2 | Project with two repositories; a repository added to a second project | Created; the second membership refused |
| 3 | Submission for a repository in a named project | Task in that project; one repository; numbering per repository |
| 4 | Board project filter and `projects`, `project.get` by key and by member repository | Scoped to the project's repositories; `repo#N` shown in a multi-repository project |
| 5 | Old-shape `project.get` call | Refused with a pointer to `repository.get`; `repository.*` round-trips the settings. `project.set` was removed outright on 2026-10-31 (its always-refusing stub had no callers) |
| 6 | Task in a two-repository project | Sibling worktree created detached at the fetched `origin/<base>`; path in the prompts; commit recorded on the run and the outcome row |
| 7 | `queue.siblings: false` | No sibling worktree; prompts unchanged |
| 8 | Worker edits, commits in, or moves a sibling | Sibling-change finding in detail and for the reviewer; nothing merged or pushed from the sibling |
| 9 | Task cleanup, cancellation and purge | Sibling worktrees removed; operator checkouts untouched |
| 11 | Park and unpark a project with a running task, a blocked task and a draft awaiting approval | Hidden from the selector and All projects; the task keeps running; the blocked task and draft still show as attention marked parked; unpark restores everything; park twice is idempotent; a stale version is refused |
| 12 | Remove an unused project, then export and import | `project.remove` deletes it and writes a tombstone; outcomes, closed leads and events still resolve; an unused `repositorySettings` row goes, one another project shares stays; the export omits the project and import never restores it; Paseo state untouched |
| 13 | Remove a project with each blocker present | Refused, naming the non-terminal task, the open lead, papercut and decision, the active lane and the pending submission; the project and its tombstone are unchanged |
| 10 | Restart during sibling creation | No duplicate worktree; an uncertain creation is reconciled by path and commit, never recreated blindly |

## Out of scope

Multi-repository tasks (PR sets, several heads reviewed together, ordered
merges), writable siblings, and changing where Paseo places the task worktree.

## Project management (Tom, 2026-10-07)

Tom requested a plugin interface to tidy the project list, including dormant
projects, and to choose reassignment or removal when attached work exists.
**Remove**, the trash icon on an opened project in Settings → Projects (lane
`nucleus-ui`, task 946), opens a centred dialog scoped to that project: the
open records from the preview, one line on what happens, a reason, and one
danger button that names its effect ("Delete project", "Cancel N tasks") and
asks once more; a new preview withdraws that confirmation. Remove only removes:
moving a project's work into another project is **Move into** (nucleus#969),
so the dialog has no "Move to" choice (Tom, 2026-11-09, nucleus#982). Every
project is removable without first assigning an owner. (It replaced the
selector's **Manage projects**.)

`project.management-preview` reads the complete project membership and attached
open tasks, leads, papercuts, lanes (including paused lanes), legacy approval
drafts, decisions, pending submissions, accepted operations and running QA.
Its digest pins the project, planning records, task identities and plan. A move
also pins the destination and its plan. Task progress alone does not change the
confirmation, but any new task or changed planning record requires refreshing.

`project.manage-remove` has two explicitly confirmed choices:

- **Move repositories and work:** attach all source repositories to the chosen
  project and tombstone the source. Tasks keep their repository identities,
  numbers, callbacks, workspaces, PRs and current runs. Leads and other records
  keep their repository bindings. Destination ownership and project settings
  apply. Destination plan order stays first; source entries append without
  duplicate lanes, and source plan versions become destination history.
- **Remove attached work:** cancel the preview's open tasks through the existing
  durable bulk-disposition control with `workDisposition: preserve`. The UI saves
  that operation identity before delivery and reconciles the same request after
  an interrupted response. Completion never follows uncertain delivery blindly.
  After cancellation settles, refresh and explicitly confirm the final inventory.
  One transaction drops open leads, deprecates papercuts without rebuilding their
  approved bodies, abandons lanes, withdraws drafts and decisions, and removes
  the project. Records shared with other work are listed and also close under
  this choice. Task history, repository files, branches and retained workspaces
  are preserved. This is cancellation and withdrawal, never fabricated completion.

Pending submissions and accepted operations must settle or be resolved before
removal; reassignment can retain them. Running project QA must settle before
either choice. A project above the existing 256-task cancellation batch bound
requires cancellation in the task controls first. Unreleased leases and unfinished
dispositions refuse final deletion. No pause, profile, subscription, limit or
repository setting is reset. Confirmation and deletion are transactionally
version/digest checked; identical replay returns the recorded tombstone without
changing a recreated project. Nothing is deleted merely by opening the screen.

A definite stale task-version refusal can be reset with
`project.reset-cancellation`. It requires a server-recorded definitive refusal of the same input, no accepted
batch, matching project and task identities, and a monotonically advanced task without a disposition.
The transaction retires the old batch ID, preventing a queued or late delivery
from accepting it later. Accepted or merely uncertain delivery cannot be reset.
The UI then refreshes the inventory and requires a new confirmation. Unsettled
operations match their durable repository path even when a linked planning
record is no longer actionable.
