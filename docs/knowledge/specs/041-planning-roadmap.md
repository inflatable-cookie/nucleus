# 041 — Planning roadmap and lane close-out

Status: implemented
Owner: Nucleus runtime and UI maintainers
Created: 2026-10-03
Decision owner: Tom
Governing refs: [Spec 026](026-planning-records.md) (lane documents, project
plan, Planning tab), [Spec 019](019-lanes.md) (lanes),
[Spec 040](040-merge-hold-release-prompts.md) (owner prompts and escalation),
[Spec 032](032-operator-decisions.md) (decisions in the Tasks pipeline)

## Problem

The Planning tab lists every selected project's lanes in one long column, so
the operator can't read it as a plan. Lanes are never closed, and 108 of 137
are `active` (2026-10-03). Plans stopped changing on 2026-10-01 while work went
on. Nothing tells a planner what to aim at when a project's board drains (Tom,
2026-10-03).

## Rulings (Tom, 2026-10-03)

- The lane is the roadmap step; there is no separate step record.
- A drained lane prompts its planner, then escalates to the operator. Nothing
  closes without a judgment.
- The Tasks tab's pipeline view does not change.
- The Planning tab uses the header's project selector, not one of its own.
- A drained board is not an operator decision (Tom, 2026-10-15). Its next-aim
  notice goes to the plan owner and never escalates; read-only "board is
  drained" cards in the Decisions column were noise the operator could not
  answer.
- An owner can mark a board idle on purpose (Tom, 2026-10-15): `plan.set` takes
  an `idle` reason for a plan with no now or next lane. It answers the
  drained-board prompt, ending an open episode, until work finishes after the
  idle mark or the plan changes (a save without `idle` clears it). The
  Planning tab shows the reason. `idle` stays Nucleus-local and is never exported.
- A project's idle mark ends, and its planner wakes, only when a finished task
  was submitted by that project's planner or by the operator from the board.
  Tom ruled “Own tasks only” on 2026-11-09, then clarified the same day that
  “own” means submitted by the project's planner. A task another planner or
  thread submitted in the same repository does not count; neither do finishes
  in another project's repositories.

## Roadmap

A project's plan is its roadmap: an ordered list of lanes, each a step.

- A plan entry carries `lane`, `note`, `horizon` and `doneWhen`. `horizon` is
  `now`, `next` or `later`; existing entries keep their value. `doneWhen` is one
  line (no CR or LF, at most 300 characters; Tom, 2026-10-04: multi-part criteria
  and lists belong in the lane document) saying what finishes the step; existing entries have none.
- **Done** is not a horizon. A plan entry whose lane is `done` or `abandoned`
  shows in a collapsed Done band with its close date and note, and leaves the
  order.
- `plan.set` accepts `next` and `doneWhen`. A `now` or `next` entry without
  `doneWhen` saves, but the tab marks it "done-when not set".
- The plan owner is the project's planner (Spec 058 cutover 5; it was the Spec 042 owner thread, retired 2026-11-02, and before that the agent that last saved the plan). A board save makes the
  operator the owner.

## Lane close-out

- **Drained:** a lane in a plan is drained when it has no unfinished task and
  no open lead, and nothing attached to it has changed for `laneDrainMinutes`
  (Nucleus setting, default 120).
- **Prompt:** Nucleus sends the plan owner one durable notice per drain episode:
  lane, aim, `doneWhen`, the tasks that finished and their outcomes. It asks
  for one of three: close the lane (`lane.status` `done`), brief more tasks
  toward its aim, or keep it with a reason.
- **Keep:** `lane.keep` with a required reason ends the episode. A new episode
  starts after the next drain.
- **Escalation:** after `laneDrainEscalationMinutes` (default 1440) without an
  answer, the lane appears in the Tasks pipeline's Decisions column as a Nucleus-raised item with
  Close and Keep. Keep asks for a reason. An operator-owned plan escalates
  straight away, with no prompt.
- New work attached to the lane (a task or a lead) ends the episode.

## Next aim

A lane can appear in more than one project's saved plan when it lists their
repositories. Each board's drained notice reads its own complete saved order,
horizons and acceptance text. Lane-level drain episodes remain shared and send
one notice per lane, rather than one per project.

When a project's last unfinished task finishes, Nucleus sends the plan owner one
notice per drain episode. A board drains when its work finishes, not by sitting
idle: a project whose latest task finished more than `laneDrainEscalationMinutes`
ago starts no episode (2026-10-03: at go-live every dormant project fired a next
aim at its importer). It carries the top `now` step's aim, `doneWhen`, document
version and open leads, and the first `next` step. It asks for briefs toward
the step, a move from `next` to `now`, or a close. With no `now` or `next` step
it asks for a plan. The text is refreshed from the current plan and lane state
before delivery intent for both lane and project prompts, while the episode
remains open; each episode still has one durable notice. The board episode
never escalates; the Planning tab's Drained flag is the operator's view of it.

Queued or running milestone QA in any of the project's repositories keeps its
board from being drained. Drain evaluation ends an existing project episode
while QA is active, and the delivery-boundary refresh supersedes an unsent
next-aim notice if QA starts before delivery. All active runs count, including
an older run hidden by a newer settled result. Settled or held QA does not
suppress normal drain detection. QA has no lane binding, so lane close-out
notices remain separate. This changes neither the plan nor existing operator
decisions, and grants no authority to launch or repeat QA (Desktop milestone
false-drain report, Tom's Nucleus ownership direction, 2026-10-09).

## Planning tab

Replaces the Plan column in Spec 026's Planning tab.

- **Project chooser** (Tom, 2026-11-07, lane `nucleus-ui`; supersedes the
  2026-10-03 rule that the tab has no selector of its own). The tab carries a
  project chooser for the operator's Planning work. It is a view over the same
  project scope the header selector writes, never a second scope: choosing a
  project writes the selection, "All projects" clears it, and nothing new joins
  the board header. With one project in scope, the tab shows its roadmap. With
  several, or all, it shows one compact row per project (name, top `now` step,
  counts) and expands one at a time.
- **Find lanes** (nucleus#866) is where a lane is found: the separate Lanes
  destination is folded into this tab. The search reads the same lane records
  the agent CLI uses and reaches project by project through the chooser, with a
  clearly labelled all-projects scope for cross-project discovery. A result
  shows the lane's title, aim, project and status. Opening one keeps the
  originating plan context: the lane column stays beside the plan, a lane found
  outside the chosen project stays open, and the lane lists every project that
  lists its repositories with each project's own plan position (horizon and
  place in that horizon). A shared lane has no single global order. Loading, a
  failed read and a stale plan stay distinct from an empty result, and no first
  page is presented as a total.
- **Now:** full cards with aim, `doneWhen`, tasks done and live, open leads,
  last activity, and a Drained flag with its age.
- **Next** and **Later:** compact rows with title, aim, `doneWhen` and counts.
  Reading shows no controls. **Edit plan** opens a draft, the only place that
  reorders steps or changes a horizon: accessible Up and Down, Move to Now /
  Next / Later, Add to plan for unplanned lanes, a visible draft with Save plan
  and Cancel (Tom, 2026-11-07: no drag-only ordering). A save writes a plan
  version against the version the draft was based on.
- **Conflict:** when the saved plan moves past the draft's version, the draft
  stays on screen and cannot be saved. Reapply moves its order and horizons onto
  the saved plan (steps the saved plan no longer has leave the draft); Reload
  discards it. A refused save shows its reason beside the draft.
- **Idle:** a deliberate mark on the draft with a required reason, offered only
  when nothing is in Now or Next. While Now or Next has steps, the draft says how
  to get there and offers Move all to Later. Saving a changed plan or finishing
  new work ends the mark.
- **Failures:** a plan that cannot be read is an error with Retry, never an
  empty plan. A refresh failure keeps the last version and says it may be out of
  date. Loading shows its own state.
- **Done:** collapsed, with a count, newest first.
- **Latest QA** (nucleus#869): the plan ends with the project's latest milestone
  QA result on one line — state, failing step, short commit and time — linked to
  that run in the QA runs tab, which owns the steps, failure, output, teardown
  retry, launch and cancel. Planning duplicates none of those controls. A queued
  run reads as waiting for a slot, never as running. A first read, a failed read
  and a stale result stay distinct from no run: loading and failure say so, a
  refresh failure keeps the last result and says it may be out of date, and only
  a completed read with no run says there is none.
- Lanes that list the project's repositories but sit outside the plan go behind
  "N unplanned lanes", each with Add to plan and Close.
- Selecting a step opens the existing Lane view: document, history, leads, plus
  the lane's tasks.
- Dark theme only when checked by eye.
- Built in part 1: `plan.get` returns `done` (lanes that sat in the plan and are now `done` or `abandoned`, read from plan history, newest close first) beside `entries`; saves send open lanes only. The Drained flag is in the view model and hidden until part 2. Add to plan puts a lane in Later.
- Built in part 3 (nucleus#866): the project chooser and "Find lanes" share `shared/lane-finder.ts`; the lane panel shows each project's plan position; the separate Lanes destination and its table are retired (Spec 019, revision 2026-11-07).
- Built in part 4 (nucleus#867): the lane panel is the shared `client/lane-screen.tsx`. It shows the aim, a preview of the latest document with Read full document (every version, Earlier and Later), and Edit. A save sends the version the text was written against; a newer version blocks the save until the operator uses it as the base or discards their text, and the draft survives leaving the tab. Work, Leads and Papercuts sit beside the document at wide sizes and below it at narrow ones. Papercuts are the open leads tagged `papercut`. A count shows only when its read is complete: lane task counts come from the lane's server totals, and a loading, failed or partial list says so. Lane key, repositories and status sit behind Details.
- Built in part 5 (nucleus#868): selecting a lead from the lane's list opens the shared `client/lead-screen.tsx` (Spec 026, "the lead screen"). The lane's open lead and papercut lists show eight records and offer the next page from the lane's complete read, so "Showing 8 of N" carries the lane's total and no first page is presented as one.
- Built in part 6 (nucleus#869): the project plan ends with `ProjectQaLatest`, one compact line for the latest milestone QA run, linked to the shared QA detail in the QA runs tab. Planning no longer launches or cancels QA — that tab owns those actions, and the QA fence stays in the board header — so the two surfaces stopped competing. A queued run reads as waiting, never running, and a loading, failed or stale QA read never reads as an empty one.

## Rollout order

The tab ships first, so the operator sees a step before agents are prompted
about it. Prompts and escalation ship second, with the skill update. The
Northstar Chatterbox is warned before the skill changes.

## Implementation notes

- Prompts, escalation and episode bookkeeping run from an hourly bounded store
  pass beside the lane idle-close (`evaluateLaneDrains`), and the notices
  deliver through the durable pending → intent → delivered path hold prompts
  use (`deliverDrainNotices`); nothing is resent blindly and a notice whose
  episode ended before delivery is superseded. Timers are the `laneDrainMinutes`
  (120) and `laneDrainEscalationMinutes` (1440) Nucleus settings.
- Episode state lives on the lane (`lane.drain`) and the project
  (`project.drain`) and is operational: it never bumps the operator-edit
  version, never travels in an export, and re-forms from activity after a
  restart. A keep is recorded on the lane (`lane.keep` — `reason`, `at`,
  `by`) and clears the episode; closing, pausing, new work, an open lead, or
  leaving the plan clears it too. The project episode's `lane` is the top `now`
  step when it began, so a plan that moved on ends the episode.
- The drain moment is detection time, and the escalation timer runs from there,
  so an owner always gets the full window. Episodes start only for saved plans:
  a project nobody ever saved a plan for — including the default
  per-repository project — is never prompted and never escalates, because there
  is no roadmap to aim at and no owner to ask. An owner Nucleus cannot name
  (empty or missing) is treated like an operator-owned plan: its lane escalates
  with no prompt, and its board gets neither. An owner thread that vanished before delivery supersedes
  the notice; the escalation timer still reaches the operator, so an unreachable
  owner is covered rather than lost.
- Escalated lanes reach the operator through the shared decisions data the
  pipeline renders (`lane_drain` cards in the Decisions column, with Close and
  Keep), not a separate surface. Boards have no card. The Planning tab shows the
  Drained flag with its age on the roadmap step.
- A board can drain while its lanes drain, so a fully drained project sends a
  lane close-out prompt and a next-aim notice; they ask different questions and
  dedupe per episode.

Times are first guesses and are settings, not constants (Tom, 2026-10-03).

## Acceptance

| # | Case | Expected |
|---|---|---|
| 1 | Planning tab with one, then three, projects in scope | One roadmap; then one compact row per project, one expanded at a time; the tab's chooser writes the same scope; no header addition |
| 12 | Find lanes from one project, then from the labelled all-projects scope | Results show title, aim, project and status; a lane outside the chosen project opens and keeps the plan context |
| 13 | A lane two projects list | Each project's own position is shown; no global order is implied |
| 14 | Lanes still loading, failed, or a stale plan, then a query with no match | Each says its own state; empty says no match; never a silent empty list |
| 2 | Plan with now, next, later and a done lane | Four bands; Done collapsed |
| 3 | Move a step from Next to Now and save | New plan version, `horizon: now`; a stale save is refused |
| 4 | `now` step without `doneWhen` | Saves; tab marks it |
| 5 | Lane's last task finishes, no leads, timer passes | One notice to the plan owner |
| 6 | Same drain, before escalation | No second notice |
| 7 | Escalation timer passes | Tasks pipeline item; Close sets `done`; Keep needs a reason |
| 8 | New task or lead on a drained lane | Episode ends; item clears |
| 9 | Project has no unfinished task or queued/running milestone QA | Next-aim notice with the top `now` step and first `next` step |
| 10 | Project with no `now` or `next` step drains | Notice asks for a plan |
| 11 | Pipeline view | Unchanged; existing pipeline tests pass as they are |
| 15 | The plan's latest QA: a queued run, a failed run, a loading read, a failed read, a refresh failure and no run | Each says its own state; the queued run reads as waiting and never as running; the link opens that run in the QA runs tab; Planning offers no QA launch, cancel or teardown retry |
