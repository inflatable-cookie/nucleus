# 053 — Demand-based profile selection

Status: implemented
Owner: Nucleus runtime and UI maintainers
Created: 2026-10-21
Decision owner: operator (Tom, 2026-10-21: "remove the 'worker, reviewer,
coordinator' role switches and lean more into capability and cost metrics …
base the choice off the complexity of the task, the position of the slider and
the relative cost of the options"; "Continue with the demand formula")
Governing refs: [Spec 030](030-routing-changes.md) (routing, capability fit),
[Spec 052](052-usage-level.md) (usage level, sign-off),
[orchestration contract](../contracts/orchestration.md) (profile eligibility)

## Problem

Automatic selection filters the pool by role and scope switches, then weights
the survivors by a soft capability fit. The switches carry no real
information (every model can work, review and coordinate), so the operator
uses them only to keep a strong model off trivial work, with no global effect.
The capability fit is a bounded preference that never decides. So the
operator's two real levers, task complexity and the usage slider, don't drive
the choice, and supervisors pin profiles to get the strength they want.


## Cost leans, it doesn't exclude (Tom, 2026-11-04)

Tom: "Queue should _lean_ towards a lower cost model in the capability tier, not exclude all other options based on cost!" Selecting the cheapest cost as the tier left GLM (low) alone at medium demand, so DeepSeek, Grok and Haiku (medium cost) got work only when GLM was unavailable. Cost now biases rotation among every profile that meets the demand; it never removes one.

Tom, 2026-11-04, the selection order (relayed by the Nucleus planner): "It should filter by complexity, then weight each model by cost, the weighting metric in profile settings, usage rotation, etc". So: filter by capability against the demand, weight each kept profile by its cost lean times its configured weight, then rotate by recent use over that effective weight.

## Rule

Each run gets a **demand**: the capability level it needs.

```
demand = clamp(task complexity + role offset + slider offset, very_low..very_high)
       # at Maximum the top of the clamp is frontier
```

- **Task complexity** is the task's `complexity` (`very_low`..`very_high`). An
  unset complexity counts as `medium`.
- **Role offset** is how much less a role needs than the task: worker 0,
  reviewer 0 (Tom: "Match the task"), coordinator −2 by default. Settings →
  Dispatch limits → Role demand changes them host-wide, each from −4 to +4
  (`queue.demand-offsets`; Decision 6). Selection and the board read the stored
  values; an invalid stored value falls back to the defaults.
- **Slider offset:** Minimal −2, Low −1, Normal 0, High +1, Maximum +2. The
  cost ceiling of [Spec 052](052-usage-level.md) still applies at every level.
  Below Maximum demand stays within `very_high`; at Maximum it may reach
  `frontier` (Tom, 2026-11-09).
- **Profile capability** runs `low, medium, high, very_high, frontier` (Tom,
  2026-11-09: "get rid of very low, and instead add `frontier` to the other end
  of the scale"). A `frontier` profile meets any demand when the level allows
  it, which is only at Maximum ([Spec 052](052-usage-level.md)).
- **First worker step** (Tom, 2026-11-01): at Normal usage, the first worker
  selection starts one step below full demand, with a floor at `low`. After an
  applied substantive author-change review, later worker selections use full
  demand. Other usage levels use full demand; an honoured profile request still
  replaces automatic selection.
- **Worker selection after review** (Spec 058 cutover 3): review history never
  adds demand or automatically replaces the author. A stronger worker model is
  selected only by an effective `route role=worker` or ordinary provider-failure
  handling. Non-converging reviews use the planner ladder and the six-round cap.

Selection for a run then:

1. Starts from the enabled pool profiles whose subscription group is
   available, which the slider's cost ceiling and frontier tier allow (or a
   request signed off on the board), and which pass review independence for a
   reviewer. A
   profile with no cost is never cost-gated ([Spec 052](052-usage-level.md));
   the board's preview applies the same gate.
2. Keeps every one whose `capability` is at least the demand, whatever its cost.
   An unrated capability counts as `medium`.
3. Weights each kept profile by its **effective weight**: the configured
   `weight` times the **cost lean**. The lean is `COST_LEAN` (2) for each cost
   step below `very_high`: very_low ×16, low ×8, medium ×4, high ×2, very_high
   ×1. An unrated cost counts as `medium`. Cost only shifts share; it never
   removes a kept profile. The constant lives in `shared/demand.ts`.
4. Rotates among them over the last 50 assignments: the profile with the lowest
   recent use over its effective weight goes first. The subscription group's
   recent count paces without deciding; lifetime use over effective weight and
   then the profile id break ties.
5. If no profile meets the demand, keeps the most capable eligible profiles and
   rotates among them the same way; the board shows the shortfall
   ("demand high, best available medium").

An explicit request still applies under [Spec 052](052-usage-level.md)
sign-off; it replaces the demand result for that role.

**What retires:** the pool's `roles` and `scopes` switches, and the soft
capability-fit multiplier (demand replaces it). A task's `scope` stays readable
history and no longer gates selection. The by-request flag that Decision 2
kept was retired on 2026-11-09 ([Spec 052](052-usage-level.md)): a frontier
capability now keeps a profile behind sign-off below Maximum.

## Visibility before rollout

The task detail shows each role's demand and the profile the formula would
pick now ("worker · demand high → Deepseek · medium cost"), as a read-only
preview computed on the board from the pool, the catalog, the usage level and
the task (`shared/demand.ts`), before selection switched over. A shortfall is
shown in warning colour with the profiles a signed-off request could reach.
Tom reviewed the preview and approved the switch (2026-10-21: "Preview looks
fine for now. Go"); there is no Settings toggle, and the old weighted path is
deleted. Settings no longer shows role or scope switches; stored `roles` and
`scopes` stay readable and are ignored. Skills and supervisors are told only
after the switch is live (the "operator UI before agent rollout" rule).

## Decisions (Tom, 2026-10-21)

1. **Ratings fill the high gap.** Tom rated Deepseek v4 Flash `high`
   capability at `medium` cost ("the most recent version is very capable"), so
   a high-demand worker at Normal picks Deepseek, cheaper than Sol.
2. **Sol is unflagged at switchover; Opus stays flagged.** A reviewer cannot
   share the author's model, so when Deepseek authored a high task the other
   high-rated profiles were Sol and Opus, both by-request, and the review fell
   to a medium model. Tom: "Unflag Sol only". When demand selection is turned
   on, Sol oracle's `byRequest` flag is cleared, so Sol (high cost, within
   Normal's ceiling) reviews those tasks automatically; Opus Oracle stays
   by-request and above Normal's ceiling. The live flag is unchanged until
   then: under today's weighted selection it would put Sol into ordinary
   rotation. (Superseded 2026-11-09: the flag is retired, Opus moves to the
   frontier tier by the operator's setting, and Sol is automatic by cost at
   High; [Spec 052](052-usage-level.md).)
3. **Reviewer offset 0.** Tom: "Match the task". The reviewer needs the
   capability the work needs.
4. **Complexity required after the preview.** Tom: "Require it". Delivered
   after the switchover was live and Tom checked the UI (2026-10-22). A new
   submission without `complexity` is refused with a message naming the field
   on its first acceptance at every intake that creates a task:
   `queue.submit`, `operation.start` (`submit` and `review_entry`), handoff and
   brief submission, the lead check, and promotion. A papercut
   promotion names it (`papercut.promote-task` `complexity`, and a picker
   beside the board's Promote); a lead names it in its brief. A promotion
   without it is refused before any operation exists. Executing or replaying an
   operation Nucleus already accepted never re-applies the requirement, so work
   accepted before it still completes. Stored tasks without it keep
   counting it as `medium`. The northstar-queue skill was updated and the
   Northstar planner warned first.
5. **Escalation keeps its reservation** (Tom, 2026-10-22: "Keep reservation").
   A pure demand step could land on a model no stronger than the author (a
   high-rated author on a medium task: demand +1 is high again), so the
   escalation still reserves a strictly higher-rated profile, and the +1
   demand step applies to the worker's later automatic picks.
6. **Role offsets in Settings** (Tom, 2026-10-22: "Build it in #592"). The
   offsets are a host-wide setting under Dispatch limits, not constants.

## Acceptance

| # | Case | Expected |
| --- | --- | --- |
| 1 | Complexity medium, Normal, worker | Every profile rated ≥ medium rotates; medium-cost profiles get twice the share of high-cost ones (Grok) and four times a very_high-cost one, none is starved |
| 2 | Complexity high, Normal, worker | Deepseek (high capability, medium cost) |
| 2b | Same task, reviewer, Deepseek authored | Sol oracle at High (very_high cost is above the Normal ceiling) |
| 3 | Complexity high, coordinator | Demand medium: every profile rated ≥ medium rotates with the lean |
| 4 | Complexity very_high, Normal | Opus (frontier) and Sol (very_high cost) need a request: best available, shortfall shown |
| 5 | Same task at Maximum | Demand reaches frontier: Opus |
| 6 | Same task at Minimal | Demand two steps lower, within the low cost ceiling |
| 7 | Reviewer shares the author's model | Excluded, as today |
| 8 | Author escalation history (rows stripped 2026-11-09, task 989) | No demand change |
| 9 | Signed-off request | Used for that role whatever the demand |
| 10 | Pool entry limited to one role or scope | Still selectable for every role and task scope |
| 11 | Two profiles at equal cost and capability, weights 2 and 1 | Share follows weight (2:1) |
| 12 | Same capability, costs medium and high, equal weight | Medium-cost share is twice the high-cost share; the high-cost one still gets work |
| 13 | Unavailable subscription group in the set | Skipped; the rest of the set rotates |
