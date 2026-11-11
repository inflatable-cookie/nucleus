# 019 — Lanes

Status: implemented
Owner: Nucleus runtime and UI maintainers
Created: 2026-09-26
Decision owner: Tom
Governing refs: [orchestration](../contracts/orchestration.md),
[Spec 018 durable outcomes](018-queue-owned-closeout-and-durable-outcomes.md),
Northstar Spec 042 (Nucleus pilots features for the separate retired Nucleus system), nucleus
`docs/knowledge/contracts/002-core-requirements.md#project-work-lanes` (the ruled
membership model), [Spec 025](025-outcome-query.md) (outcome search by lane)

## Problem

Tasks are disparate. Dependencies say what must finish first, but nothing says
which piece of work a task belongs to or what it is working towards. Large
projects run many lines of work at once, and the operator tracks them by memory.
A line of work with nothing currently running disappears from view entirely.

## Outcome

A **lane** is an opt-in, durable grouping object with a grounded aim. It may span
several repositories when the work is genuinely cross-project. A task belongs to
zero or more lanes (revision below). The board can switch between the current status view
and a lane view with the same styling, grouped by lane. Active lanes stay visible
when they have no running tasks.

Lanes group work. They do not gate dispatch, replace dependencies, or grant
authority. A task's handoff or brief still governs its scope.

**Vocabulary.** Nucleus's docs and code have used "lane" to mean one task, and the
board code calls its status columns `boardLanes`. From this spec on, a lane is
the grouping object only. Code renames the status columns (`statusColumns`), and
new docs say "task" for a single unit of work. Closed historical documents are
not rewritten.

## Revision: many-to-many membership (2026-09-26)

Tom ruled that Nucleus matches the separate retired Nucleus system: "Queue should update to match nucleus on
multi-lane." Tasks often span several lanes, and those tasks are the pinch points
that most need to be visible. Everything else in this spec is unchanged,
including closing a lane without a settlement guard. Where the sections below
say "the task's lane", read "each of the task's lanes".

- **Membership.** A task has zero or more lanes. Every lane it joins must list
  the task's repository and be `active` or `paused`. A shared task keeps one
  identity, workspace, execution and outcome. Its lane list holds no duplicates
  and keeps the order given.
- **Submission.** Frontmatter `queue.lane` takes a key or a list of keys, and
  `queue.lanes` takes a list. Giving both is refused. Every key is checked at dry
  run and submission; one bad key refuses the whole submission, so a task never
  joins a partial set.
- **`set_lane`** sets the task's full lane list (`lanes`, versioned). An empty
  list clears it. The existing single `lane` input (a key, or null) stays
  accepted as a one-item list or an empty one. Nothing else about the task
  changes.
- **Outcome row.** `lane` becomes `lanes`, a list of keys, in the same terminal
  transaction. The migration converts every existing row and task: a lane
  becomes a one-item list, and no lane becomes an empty list. No row is dropped
  or re-dated. The single-key field goes, rather than standing in for a list it
  cannot represent.
- **Counts and history.** A lane's live counts, terminal outcome count, recent
  outcomes and `lastActivityAt` include every task that lists it. Totals across
  lanes, such as the board header's live count, count each task once.
- **Prompts.** One aim block per lane, in list order, each labelled as context.
  The aim grants no authority, and the brief or handoff governs scope. A task
  with no lanes gets an unchanged prompt, and a one-lane prompt is byte-identical
  to today's.
- **Board.** A shared task shows as one card on the board, counted once; the task
  view names every lane it belongs to (revision 2026-11-08 below).
- **Outcome search (Spec 025).** The `lane` filter matches a row that lists that
  key among its lanes. The index keeps one row per task and lane, rebuilt from
  the outcome rows.

## Revision: idle lanes close themselves (2026-09-27)

Tom: agents finishing the tasks in a lane almost never close it.

- **Auto-close.** A lane that has been idle for 14 days is closed by Nucleus:
  status `done`, with the note "Closed automatically after 14 days idle".
  Idle means no live tasks, no open papercuts, leads or drafts in the lane, and no
  lane activity (`lastActivityAt`) for 14 days. A maintenance pass checks lanes; it
  never touches a lane with any of those. The lane record stays, because outcome
  rows and outcome search reference lane keys; closing is not deletion. `lane.status
  active` reopens it, and reopening counts as activity.
- **The pass.** The engine audit runs it at most hourly, not while Nucleus is paused.
  It reads lanes, live tasks and lane-tagged records once, closes in one
  transaction and touches no task or record. Only `active` lanes close; a `paused`
  lane was parked on purpose and stays until someone closes it.
- **Idle lanes stay visible until they close.** An open lane with nothing running
  keeps its column on the Lanes view, so it can't be forgotten (Tom, 2026-09-27,
  keeping the original rule); auto-close is what removes it.

## Revision: the Lanes view is a table (2026-09-27)

Tom: the Lanes view is too unwieldy as columns. It becomes a table with one row
per lane; the Pipeline view is where a lane's work is seen.

- **Rows.** One row per lane under the project selector: `active` lanes by most
  recent activity, then `paused` lanes dimmed; `done` and `abandoned` lanes hidden,
  as before. A No lane row shows only when live tasks have no lane.
- **Columns.** Title, with the aim clamped to one line beneath it; projects;
  counts per pipeline column (Papercuts, Triage, Queued, Working, Review, the
  same counts as the lane's pipeline row); and last activity. An idle lane shows
  zero counts and its last activity, so it stays visible until it closes itself.
- **Click a row** to open the Pipeline view on that lane's work. (Retired with the
  table on 2026-11-07; the board's swim-lane view went on 2026-11-08.)
- **Project scope on click** (Tom, 2026-09-27). If the project selector has no
  projects selected, clicking a row selects the lane's projects, so the Pipeline
  view opens scoped to that lane's work. A selector that already has projects
  selected is left alone. Parked projects follow Spec 027.
- **Lane detail** (full aim, status, note, recent outcomes) opens from an info
  control on the row, since clicking the row now navigates.

## Revision: lane discovery moves into Planning (2026-11-07)

Tom, 2026-11-07 (lane `nucleus-ui`): Planning is "horrible to use right now —
works fine for agents but is really hard to do anything with as an operator".
Planning replaces the separate Lanes destination (nucleus#866).

- **Retired here, unchanged elsewhere.** The Lanes tab, its table, its row
  navigation into the board and the lane-detail modal are deleted with
  `shared/lane-table.ts`. The lane record, its document, its status and every
  lane CLI route and RPC are unchanged.
- **Find lanes.** Discovery is Planning's "Find lanes" search over the same lane
  records, with a project chooser and a labelled all-projects scope. A result
  shows title, aim, project and status; opening one keeps the originating plan
  context. The lane panel shows every project that lists the lane and that
  project's own plan position. A lane can be the top `now` step of one project
  and `later` in another; nothing implies a single global order.
- **Evidence kept.** What the retired lane-detail modal held — the note, the
  repositories and the recent outcomes — now sits in Planning's lane panel, so
  folding the destination loses no record. See
  [Spec 041](041-planning-roadmap.md), Planning tab.
- A total across lanes counts each task once.
- The column-based Lanes view goes. Acceptance rows 6, 11 and 16 read against
  Planning and the Pipeline view.

## Revision: the board loses its swim-lane view (2026-11-08)

Tom, 2026-11-08: "We can lose the swim-lane rendering concept on the board, I
never use it (the switch next to the project selector)".

- **Retired.** The board's header switch, its per-lane rows, their expand and
  collapse, and the card chip naming a shared task's other lanes. The board is
  always one set of columns, each card once (Spec 026, Board).
- **Unchanged.** Lane records and documents, Planning (lane screen, finder,
  plan), a card's lane membership in the task view, lane drain and every lane
  RPC and CLI route.

## Lane record

| Field | Content |
| --- | --- |
| `id` | Nucleus identity |
| `key` | Slug, unique across Nucleus (for example `silo-adoption`) |
| `repositories` | One or more participating repositories: normalised origin (`owner/name`), with the local path as a hint only |
| `title` | Short name |
| `aim` | The grounded aim: what done looks like and why it matters, up to 2,000 characters |
| `status` | `active`, `paused`, `done` or `abandoned` |
| `note` | Optional reason for the latest status change |
| `createdAt`, `updatedAt`, `closedAt` | Timestamps |

Lanes live in their own table and are never purged. The record is host-neutral
for the separate retired Nucleus system. A lane belongs to Nucleus, not to any repository, so it can span
projects; each repository stays independent and holds no lane state.

The `repositories` list is explicit. It keeps an idle lane visible under each of
its projects before any task exists, and it gates attachment. Adding or removing
a repository is a `lane.upsert`. Removing one that still has live tasks in the
lane is refused.

## Attaching tasks

- **At submission:** handoff frontmatter `queue.lane: <key>`. The lane must exist,
  list the task's repository, and be `active` or `paused`. An unknown key is
  refused at dry run and submission, never auto-created, so a typo cannot create
  a stray lane.
- **Later:** operator control `set_lane` (lane key, or none) on a live task. It
  is versioned like other controls and changes nothing else about the task.
- **Terminal:** the Spec 018 outcome row records the task's lane key, so lane
  history survives the task purge. This adds one nullable field to the row, in
  the same terminal transaction.
- Brief submissions (Spec 020, which lands first) take the same `lane` field.

## Lane operations

RPC, CLI and Nucleus skill:

- `lane.upsert`: create a lane, or change its title, aim or repositories, by key.
- `lane.status`: set `active`, `paused`, `done` or `abandoned`, with an optional
  note. Closing a lane never touches its tasks: live tasks keep running and stay
  attached.
- `lanes`: list by status, optionally filtered to lanes that list a repository.
  Each lane includes counts of live tasks by phase and by repository, a count of
  terminal outcomes, and `lastActivityAt`: the latest of the lane's own update, a
  task event or outcome in the lane, and papercut filing or closing, lead updates
  and open draft updates in the lane. A papercut or lead resolved inside the idle
  window therefore keeps the lane open.

## Aim in prompts

Worker and reviewer prompts for a task with a lane carry one short block: the
lane title and aim, labelled as context for why the task exists. The handoff or
brief governs scope, and the aim grants no authority. Tasks without a lane get
unchanged prompts.

## Board

A toggle beside the project filter switches between **Status**, the current
view, and **Lanes**. The Lanes view is a table since 2026-09-27 (revision above);
the column description below is historical.

- The project filter selects which lanes appear: every lane that lists the
  project. All projects shows every lane. One column per `active` lane, ordered
  by most recent activity. `paused` lanes follow, dimmed. `done` and `abandoned` lanes are
  hidden.
- A **No lane** column holds live tasks without a lane. It is shown only when
  there are some.
- A column header shows the title, the live count and the aim clamped to two
  lines. Tapping it opens a lane detail with the full aim, status, note and
  recent outcomes, which link to their PRs.
- A lane's column shows all of its live tasks, whichever project is filtered,
  because a cross-project lane is only legible whole. Cards are the existing task
  cards: the project and short number, the phase, the wait or next action, and the
  hold, stop, interactive and decision badges. A card names its project in its
  eyebrow when the lane spans more than one repository. Lane names, long IDs and
  timestamps live in the task view (UI lane step 2, 2026-11-07).
- An active lane with no live tasks shows "No tasks running" and its last
  activity, so an idle lane stays visible rather than disappearing, until it closes
  itself after 14 idle days.
- Creating and editing lanes happens through the CLI and skill in this version.
  The board is read-only for lanes.

UI acceptance uses the installed bundle in dark theme, at both existing viewport
sizes, with an empty lane, a paused lane, a two-repository lane, a task shared by
two lanes, the No lane column and a long aim. The
Status view must be unchanged.

## Acceptance oracle

| # | Scenario | Required result |
| --- | --- | --- |
| 1 | Task submitted with a known lane key | Attached; shown in that lane's column |
| 2 | Unknown key, a `done` or `abandoned` lane, or a lane that does not list the task's repository | Refused at dry run and at submission |
| 3 | `set_lane` on a live task, including clearing it | Lane changes; nothing else about the task changes |
| 4 | Lane closed while tasks run | Tasks keep running and stay attached; the lane is hidden in the view once they finish |
| 5 | Task purged after finishing | Lane counts and outcome history still include it through the outcome row |
| 6 | Active lane with no live tasks | Visible, with its last activity |
| 7 | Prompts with and without a lane | Aim block present only with a lane; otherwise byte-identical to today |
| 8 | Tasks without lanes, repositories never using lanes | Behaviour, board Status view and prompts unchanged |
| 9 | Duplicate key; lane spanning two repositories | Refused; tasks from both attach and show in one column, each card naming its project |
| 10 | Lanes and lane attachment across restart and migration | Preserved; old stores migrate with no lanes |
| 11 | Project filter on a cross-project lane | The lane appears under each listed project, with all its tasks; an idle lane appears too |
| 12 | Removing a repository that still has live tasks in the lane | Refused |
| 13 | Submission with a list of two lane keys, and with `queue.lanes` | Attached to both, in order; `lane` and `lanes` together refused |
| 14 | A list with one unknown, closed or non-listing key | Whole submission refused at dry run and submission; nothing attached |
| 15 | `set_lane` with a full list, a changed list and an empty list; the single `lane` input | List replaced exactly; empty clears; single key becomes a one-item list; version checked; nothing else changes |
| 16 | Shared task on the board | One card, counted once; its lanes are named in the task view; an action on the card acts on the one task |
| 17 | Counts with a shared task | Each lane counts it; totals across lanes count it once |
| 18 | Prompts for zero, one and two lanes | Zero unchanged; one byte-identical to today; two carry two aim blocks in list order |
| 19 | Migration of a store with single-lane tasks and outcome rows | Every row and task carries `lanes`; no rows lost; restart keeps them |
| 20 | Outcome search by lane for a two-lane outcome | Found under either key |
| 21 | Lane idle for 14 days, one idle for 13, one with a live task, an open lead, an open papercut or a draft | Only the first is closed, with the automatic note; the others stay open |
| 22 | Auto-closed lane reopened with `lane.status active`; outcome search by its key | Reopens; its outcomes are still found |

## Out of scope

Lane-level dependencies or gating, lane editing from the board, notifications for
idle lanes, and lane templates.
