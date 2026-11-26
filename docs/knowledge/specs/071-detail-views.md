# Spec 071 — Detail views for tasks, leads and papercuts

Status: approved. Tom, 2026-11-26, on the task details view: "The task details view is pretty useless - ugly, doesn't put the most important information first, rendering errors, etc. We need to completely redesign it - I like the timeline bar, that just needs fixing, but pretty much everything else is up for complete redesign." Then: "We need to do the same for details view for leads and papercuts, which are both also useless.." After reviewing the mockup (13 states, dark theme, kept with the planner's evidence): "This looks good - go with your recommendations. We can tweak once it's built if anything feels off".

## Decisions

Tom accepted the planner's recommendations on 2026-11-26:

1. One scrolling view, no tabs, so a question or block is never hidden.
2. Planner questions show an Answer form to the operator, collapsed by default. A `?` explains that the planner normally answers them.
3. Task actions sit in a footer: Hold and Move on the left, and Cancel apart on the right, with a confirmation.
4. The timeline uses equal steps with round segments. Exact durations and timestamps go in tooltips.
5. Engine data comes first: serve each role turn (the lifecycle transcript) to the board, giving per-round timings and thread links in one change.
6. Leads and papercuts gain reopen (parked or dropped back to open). A revisit date marks a parked item due; it does not reopen automatically.

## Lifecycle journal facts

Task updates record each phase transition with its previous and new phases at
the update's journal time, in the same transaction. Provider-limit events record
the run instance, subscription group and observed reset time (null when unknown).
Older journal rows remain valid; absent transition facts do not establish a time.

## The idea in one paragraph

Each detail view answers three questions, in this order: what state is
it in, does anyone need to act (and who), and what's the evidence? Tabs go:
one scrolling view, so a question or a block is never on a hidden tab. A
tinted attention panel appears only when a person (Tom or the planner) has to
act, and it holds that action. Everything else is quiet: one progress card,
one PR card, activity, then the brief. Routine actions sit in a footer, and
the destructive one sits apart on the right and asks for confirmation first.

## Task view

### Who opens it, and when

Tom opens it from a board card or the Inbox, usually for one of three reasons:
a card is in Needs you, something looks slow, or he wants to know how a task
ended. Planners work through `nucleus next`; they open the board only when Tom
sends them there. So the view uses `next`'s vocabulary (state label, wait,
question, commands), and Tom and the planner describe a task the same way.

### Workflow by state

| State (label) | Who acts | What matters first | Likely next action |
|---|---|---|---|
| Queued · capacity | nobody | how long it has waited | Promote (ruling 50), Hold |
| Queued · prerequisite | nobody, unless a prerequisite is cancelled or missing | which prerequisites, and their phases | Edit prerequisites |
| Working / Reviewing | nobody | live activity, elapsed time, model, allowance | none; Open thread to watch |
| Working · planner (question) | planner (Tom may answer) | the question, how long it has waited | Answer |
| Working · Tom (accept, usage) | Tom | the decision and the exact head | Answer / Accept |
| Changes | nobody | the findings that sent it back, which round | none; Hold if looping |
| Merging · checks | nobody | PR, approved head, checks, next check time | none |
| Merging/Closing · GitHub, workspace | nobody until it persists | the cause and next check time | Recheck once fixed |
| Repair question / Blocked / Error | planner or Tom | plain cause, what failed, attempts | fix, then Recheck (ruling 48) |
| Held (· Tom / · planner) | the holder | the reason and who held it | Release |
| Declined | planner | the decline | Move or Cancel |
| Report ready (report-only) | planner or Tom | the delivery summary and artifact | Complete or Return to work |
| Done | nobody | merged commit, PR, rounds, total time | none |
| Cancelled | nobody | when, from which phase | none |

### Layout, top to bottom

1. **Header.** Line 1: project badge and reference (tooltip: `owner/repo`
   and base). Line 2: title. Line 3: dot and state label. Top right: age,
   Open task thread, Close. Age is time since admission, or since finishing
   for Done and Cancelled; the tooltip gives exact times and the total
   duration. The repository line under the title goes, since the reference
   already names it.
2. **Attention panel**, only when someone has to act. It's tinted by tone:
   warning for questions and holds, danger for blocks. It contains an eyebrow
   ("Planner question", "Your decision", "Needs attention", "Held") with the
   wait time on the right, the question or cause in full, then the
   controls: an option dropdown or text field and Answer; Recheck first
   for mechanical blocks; Release for holds. Waits that need no one
   (capacity, checks, GitHub) never use the panel.
3. **Progress card.** Timeline bar, then one wait line when the current
   step is waiting ("Waiting for required checks · Next check 11:42"), then
   one row per bound role (role, model, live activity, thread link) and the
   allowance as a slim bar with used/limit. This replaces the "Changes",
   Participants and Allowance cards.
4. **PR card**, once a PR exists. PR number (link), head SHA (tooltip: full
   SHA), state pill (Changes requested / Approved / Blocked / Merged), then
   the latest verdict: round, summary, finding titles. Earlier rounds sit
   collapsed underneath. A "reviewed abc1234" note appears only when the
   reviewed head differs from the PR head, which is the exact-head rule made
   visible. Checks appear while merging.
5. **Prerequisites**, while queued with dependencies, inside the progress
   card: reference (link), title, phase dot, plus Edit.
6. **Activity.** The latest 3 to 5 milestones, newest first, with "More". The
   time is relative, with the absolute time in a tooltip. Collapsed when an
   attention panel is open.
7. **Brief**, collapsed. Amend sits in its header and edits in place.
8. **Footer.** Hold or Release, Move (dropdown) and Promoted (toggle,
   ruling 50) on the left. Cancel sits alone on the right as quiet red text
   and opens an inline confirm ("Cancel this task?" / Cancel task / Keep).
   Recheck appears in the attention panel, not the footer. Done and
   Cancelled show no footer.

Done reorders: the PR card (merged, final verdict) comes before progress,
because the outcome is what matters.

### Timeline bar

Kept: five equal steps (four for report-only), green for done, the state's
tone for current, track grey for not started.

Changed:

- **Its own card, fixed rows.** The bar, label and value rows have fixed
  heights and no free-floating text. That removes the overlap: today the
  "Started …" line belongs to the card above, but the card's box ends before
  it, so it paints under the bar. The redesign drops that line entirely (the
  start time moves to the step tooltip). It's worth confirming the root
  cause in the built board, which is likely flex shrink in the scroll body,
  because other cards could clip the same way.
- **Rounds as segments.** Working and Review split into one segment per
  round. Review segments are amber for changes requested and green for
  approved. After changes, Review stays lit amber ("Round 2 · 1h 18m")
  instead of reverting to grey. Today a finished round 1 looks like a step
  that never started.
- **"Round N" only from round 2.** Round 1 adds noise. Tooltips always
  name the round.
- **One unit everywhere.** Every value is a duration. Queued shows the time
  it waited, not a clock time ("05:09 PM" today). Clock times move to
  tooltips.
- **Live elapsed time** on the current step, ticking locally.
- **Waits inside the step.** A waiting step gets a slowly drifting
  striped bar in its tone, and its value adds the wait ("1h 50m · waiting
  14m"). The wait line under the bar gives the cause and the next check.
- **Tooltips per step and per segment:** start and end times, model,
  verdict, duration.

### Removed or merged

- The Overview, Activity and Details tabs give way to one view. This also
  settles PR #915's "questions visible across tabs".
- The "Changes" card goes. Its title was the state label (worker revising
  after review), which read like a code-changes section. It showed `Worker ·
  Goal` and a raw thread ID.
- The raw thread ID, the provider instance key and the `provider / model`
  string go. The model is the primary text, the provider sits in a tooltip,
  and the thread is a link.
- The Participants and Allowance cards merge into the progress card.
- The Details tab's Repository section merges into the header tooltip and the
  PR card. The Base field goes into a tooltip.
- The Actions card becomes the footer. Amend moves into the Brief header.
- The other PR #915 items: a header Open thread button is in. The ⋯ menu is
  replaced by the footer, since there are few enough actions to show them. A
  raw-events toggle stays out for now. The full latest report suits
  report-only tasks; they should get a collapsed "Report" section like the
  Brief.

### Bugs in today's dialog, found while reading

1. **The Activity tab fails for any task with a routing record.** The engine
   writes a `run_routing` presentation entry (`attention.rs`
   `observe_run_routing`). The board's `historyRecord` discriminated union
   in `client/web/rust-board.ts` has no `run_routing` case, so the whole
   page fails with "The task engine returned an invalid response." The same
   schema also drops `run_reported.outcome`, which holds the review summary
   and finding titles.
2. **Worker purpose "Goal".** `presentation.rs` `purpose()` uses the brief's
   first line, which is often a `## Goal` heading.
3. **Overlap**, described under Timeline bar.
4. **Review greys out after changes**, described under Timeline bar.

Both bugs are briefed as their own fix ahead of the rebuild.

### Data mapping

"Board-only" means the engine already serves the field and the board's zod
schema needs to read it. "Engine" means it needs engine data.

| Element | Source | Status |
|---|---|---|
| Reference, title | `reference` / `identity.reference`, `title` | exists |
| Reference tooltip | `identity.repository`, `identity.base` | exists |
| State label, dot tone | `next.stateLabel`; current `lifecycle.steps[].tone` | exists |
| Age and tooltip | `createdAtMs`, `lifecycle.finishedAtMs`, `stateSinceMs` | exists |
| Open task thread | the task's ACP thread link | **engine** |
| Attention shown | `attention == "attention"`, `question`, blocking `hold`, `wait` | exists |
| Question text, options | `next.question` (`rustQuestionText`) | exists |
| Who answers | parsed from the label cause ("· Tom", "· planner") | **engine** (explicit `answerer`; core has `operator_question()`) |
| Waiting since | `stateSinceMs` (fixed by question or hold facts) | exists |
| Answer, Recheck, Release | `next.commands[].preflight`, `version` | exists |
| Block cause | `waitDetail` (suppressed while a question is open) | partly; **engine** for the forge's blocking reason |
| Hold reason; who held it | `hold.reason`; holder from the label | **engine** for `hold.by` and `hold.at` |
| Steps, state, tone | `lifecycle.steps[]` | exists |
| Working/Review elapsed, live | `elapsedMs`, `activeSinceMs` | exists |
| Queued, Merge, Close durations | none (only role steps carry elapsed) | **engine** (per-step `startedAtMs` / `endedAtMs`) |
| Round count | `lifecycle.reviewRound`, history `run_started.round` | exists |
| Per-round segments, verdicts, durations | `lifecycle.transcript.cards` (served only to task-session readers) | **engine** (serve the transcript to the board) |
| Wait line | `wait`, `waitDetail`, `nextCheckAt` | exists |
| Role model, provider | `lifecycle.worker/reviewer.provider/model` | exists |
| Role activity | `run.activity.label` when `run.role` matches | exists |
| Role thread link | `participant.threadUrl` (`t3-thread://…`; exists on transcript cards) | **engine** |
| Last provider limit | `next.lastProviderLimit` | board-only |
| Allowance | `allowance.usedMs/limitMs/exhausted` | exists |
| PR number, head | parse `pullRequest.url`; `pullRequest.head` | exists |
| Verdict, summary | `verdict.reviewed` / `verdict.accepted` | exists |
| Finding titles, earlier rounds | history `run_reported.outcome` (`finding_titles`), `verdict` | board-only |
| Checks list | none | **engine** |
| Merged commit | history `merged.commit` | exists |
| Prerequisites | `dependencyStatus.dependencies[]`, `dependencyEdits` | board-only |
| Activity | history `presentation[]` | exists (after the `run_routing` fix) |
| Brief, Amend | `brief.text`, `brief.version`, `amend` | exists |
| Move, Hold, Cancel | `next.commands` (`move` carries `phase`) | exists |
| Promoted toggle | ruling 50 command | **engine** (not in the command list yet) |
| Report (report-only) | `report.delivery`, `complete`, `move_work` | exists |
| Cancelled: when, from where | history `finished.phase`, `previous_phase` | board-only (`previous_phase` dropped) |

## Leads and papercuts

Both are one engine record (`Item`: kind, title, body, lanes,
repositories, author, state, reason, disposition, revisitAt, taskId,
version), so they share one view. Only the body heading ("Lead" / "What
happened") and the kind icon differ.

### Workflow

- **Triage (open).** Is it worth doing, and where? Read the body, then
  promote (repository plus complexity), park with a revisit date, or drop.
  Promote is the decision the view exists for, so it gets the panel.
- **Revisit (parked).** Why was it parked, by whom, and is the date due?
  Change the date, or drop it. Reopen returns it to Open.
- **Follow (promoted).** Where's the task now? The view becomes a pointer to
  the task.
- **Look back (dropped).** Completed or deprecated, the note, who and when.

### Layout

Same frame as the task view:

1. **Header.** Line 1: project badge, project name, kind icon and word.
   Line 2: title. Line 3: dot and state ("Open", "Parked", "Parked · revisit
   due", "Promoted", "Dropped · completed"). Top right: age (filed, parked,
   promoted or dropped time, with details in a tooltip) and Close. Items have
   no number, so the internal ID never shows.
2. **Panel** by state:
   - Open: a "Promote" panel with Repository (dropdown, only when the item
     spans more than one repository; unbound repositories disabled with a
     reason), Complexity (dropdown, default Medium) and Promote.
   - Parked: the reason, who parked it, the Revisit date as an editable
     control (changing it re-parks; the engine allows parked to parked),
     and Reopen. The panel turns warning-tinted once the date has passed.
   - Promoted: a live mini task card (reference, title, state label, slim
     lifecycle bars with tooltips) that opens the task view.
   - Dropped: disposition as the eyebrow, the note, and who dropped it.
3. **Body card**, with Edit in its header (edits at the opened version; a
   conflict says so and reloads). Below the body is one context line: lane
   chips, repositories, author. Promoted and dropped items collapse the body.
4. **Activity**, collapsed, from the item history.
5. **Footer.** Park on the left. Drop sits alone on the right and opens an
   inline form: Disposition (Completed or Deprecated; papercuts only, leads
   default to Deprecated), Note, Drop, Keep. Promoted and dropped items show
   no footer.

Removed from today's lead screen: the check and approve status block and
buttons (retired in #905), "version N" in the meta line, the "More actions"
group, Promote to a question or knowledge change, and the Details section of
raw fields. From the papercut dialog: the Area, Impact and Suggested fix
sections (the Rust item has only a body), the complexity chip row (now a
dropdown), and the two separate "Close as …" buttons (now Drop with a
disposition).

### Data mapping

| Element | Source | Status |
|---|---|---|
| Project badge, name | board project for the item's project | exists |
| Kind | `item.kind` | exists |
| Title, body, lanes | `title`, `body`, `lanes` | exists |
| Repositories | `item.repositories` or all project repositories | exists |
| Author | `item.author` | exists |
| Age | `createdAtMs`, `updatedAtMs` | exists; **engine** for the state change time (or read item history) |
| Parked reason, revisit date | `reason`, `revisitAt` | exists |
| Who parked or dropped | `history/{kind}/{id}` (`actor`, `atMs`, `action`) | board-only |
| Revisit due | `revisitAt` compared with today | exists (computed) |
| Promote | `POST …/items/{id}/promote {repository, complexity}` | exists |
| Bound repositories | project `repositories[].hostProject` | exists |
| Linked task card | `taskId` joined with the board's task list | exists (client join) |
| Edit | `PUT …/items/{id}` with `version` | exists (the adapter wires it for papercuts only) |
| Park, re-park | `POST …/items/{id}/park {reason, revisitAt}` | exists |
| Drop | `POST …/items/{id}/drop {disposition, reason}` | exists (the lead adapter sends no disposition) |
| Reopen (parked or dropped) | `POST …/items/{id}/reopen {note, version}` | exists; version and note are optional |
| Revisit date | Due indication while parked | exists; reopening is explicit |
| Activity | `history/{kind}/{id}` | exists |
