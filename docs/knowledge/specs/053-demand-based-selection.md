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

Before demand-based selection, role and scope switches filtered the pool.
The operator used them to keep strong models off trivial work. A soft
capability preference then weighted the remaining profiles. Task complexity
and the usage slider had little influence, and supervisors pinned profiles
to get the strength they wanted.


## Weight is a five-stop rotation slider; Cost is retired (Tom, 2026-11-21)

Tom, 2026-11-21: capability roles now decide eligibility, so the profile **Cost**
rating is removed and the integer **Weight** becomes a five-stop slider in the
former Cost position, beside Capability. This supersedes the cost lean below:
the 2026-11-04 ruling (cost leans, it does not exclude) is kept only as history.

- **Stops.** `weight` is the enum `fewest`, `fewer`, `default`, `more`, `most`,
  Default at the centre and for every new profile. The control shows plain words
  (Fewest, Fewer, Default, More, Most), marks the centre, and carries no number.
- **Share.** Each stop sets its relative share of Default: 50%, 75%, 100%, 150% and
  200% (`weightShare` in `shared/schema/settings/capability.ts`; steeper stops, Tom,
  2026-11-22, replacing the earlier 80% to 120% steps). A share orders rotation among profiles
  already eligible for the run. It is never an admission criterion and never a
  promised percentage of all work. Equal weights get equal rotation opportunity
  whatever a profile's prior cost.
- **One rule for selection and diagnostics.** `chooseProfile`, the selection
  explanation (`met` rows carry `weight` and `share`) and the board's preview
  rank by recent use over share (`rotationShare`). Capability and demand,
  workload, sign-off, host and subscription availability, reviewer
  independence and assignment history are unchanged. Cost-only filters in
  non-delivery routing and transient rate-limit failover are removed, and
  `routeCost` no longer reaches the coordinator route plan. Actual usage and
  subscription accounting is untouched.
- **Migration (reads only).** A stored or wire profile still carrying the old
  integer reads at the existing boundaries (`poolRecordFromLegacy` for
  `queue.pool` / `queue.profile`, the store's `pool()` read): 1 is Default, 2 is
  More, 3–10 is Most. This compresses the old 1–10 range on purpose. Any other
  integer or a non-integer still fails validation. A legacy `cost` is discarded
  and never used for the mapping or for routing. Recorded diagnostics
  (`routePolicySchema`, `selectionExplanationSchema`) drop `cost` and
  `effectiveWeight`, map a numeric `weight` the same way and derive `share`.
  Stored bytes, live settings and already assigned tasks are not rewritten; the
  next profile write emits only the canonical form.

## Cost leans, it doesn't exclude (Tom, 2026-11-04; retired 2026-11-21)

Tom: "Queue should _lean_ towards a lower cost model in the capability tier, not exclude all other options based on cost!" Selecting the cheapest cost as the tier left GLM (low) alone at medium demand, so DeepSeek, Grok and Haiku (medium cost) got work only when GLM was unavailable. Cost now biases rotation among every profile that meets the demand; it never removes one.

Tom, 2026-11-04, the selection order (relayed by the Nucleus planner): "It should filter by complexity, then weight each model by cost, the weighting metric in profile settings, usage rotation, etc". So: filter by capability against the demand, weight each kept profile by its cost lean times its configured weight, then rotate by recent use over that effective weight.

## Rule

Each run gets a **demand**: the capability bracket it needs.

```
worker      = the usage level's start bracket for the task's complexity (Spec 052)
reviewer    = never above the worker's actual profile: one bracket below at Low and
              Normal; at High one below a Heavyweight or Frontier worker and on a
              Worker worker's bracket; the worker's bracket at Extra high and
              Maximum; Mechanical for a Mechanical worker (Spec 052, 2026-11-23)
coordinator = Mechanical
```

- **Task complexity** is the task's `complexity` (`very_low`..`very_high`). An
  unset complexity counts as `medium`.
- **Profile capability** is four brackets (Tom, 2026-11-19): Mechanical,
  Worker (what were medium and high, one pool), Heavyweight and Frontier. An
  unrated profile counts as Worker.
- **Start bracket:** the usage level sets where a worker starts
  ([Spec 052](052-usage-level.md)). At Normal very-low and low complexity start
  on Mechanical, medium and high on Worker, very high on Heavyweight. Low starts
  one bracket below the bracket the task may climb to, High and Extra high at
  it (up to Heavyweight), Maximum one bracket above the task's own (Worker,
  Heavyweight or Frontier, Tom 2026-11-23). The level's permission rule
  gates Heavyweight and Frontier; cost is only the rotation lean.
- **No role offsets** (Tom, 2026-11-19: "Coordinator should always be
  mechanical if available, worker shouldn't have an offset at all"). The
  worker's bracket comes only from complexity, the usage level and the step-up.
  The coordinator, recovery coordinators included, takes Mechanical when an
  eligible Mechanical profile is available and otherwise the lowest permitted
  bracket that has one. The Settings Role demand section and
  `queue.demand-offsets` are gone; a stored value is dropped and noted in the
  migration record.
- **Step-up after review changes** (Tom, 2026-11-17, replacing the 2026-11-01
  first-worker step): an applied `changes_required` review authorizes one climb
  for the next worker run, one bracket from the bracket the worker actually ran
  on and capped at the bracket the task may climb to: a medium task stays on
  Worker, a high task climbs once to Heavyweight, a very-high task to Frontier
  only with sign-off below Extra high. The ordinary revision launch records it once per
  review run and continues on a fresh revision agent at the climbed profile. An honoured profile request
  still replaces automatic selection.
- **Worker selection after review** (Spec 058 cutover 3): apart from the one
  step-up above, review history never adds demand or automatically replaces the
  author. Any other stronger worker model is selected only by an effective
  `route role=worker` or ordinary provider-failure handling. Non-converging reviews use the planner ladder and the six-round cap.

Selection for a run then:

1. Starts from the enabled pool profiles whose subscription group is
   available, which the level's permission rule allows (or a
   request signed off on the board), and which pass review independence for a
   reviewer. A
   profile's weight never gates it ([Spec 052](052-usage-level.md));
   the board's preview applies the same gate.
2. Keeps every profile at the run's own bracket (the demand); the nearest bracket above is the bail-out when none carries it, and a
   shortfall takes the most capable profile at or below the bracket the task may
   climb to. A profile above that bracket is never automatic for a worker
   except at Maximum, whose ceiling is Frontier.
   A reviewer and a coordinator are not capped there: they take the nearest
   permitted bracket above or the most capable permitted profile rather than
   wait ([Spec 052](052-usage-level.md)).
3. Gives each kept profile its **share**: the weight stop's relative share,
   50%, 75%, 100%, 150% or 200% of Default (Tom, 2026-11-22). A share only
   orders rotation; it never removes a kept profile. `weightShare` lives with
   the weight enum and `rotationShare` in `shared/demand.ts`.
4. Rotates among them within each role (Tom, 2026-11-22, nucleus#1558). A
   selection for a role reads that role's own last 50 assignments
   (`recentRoleUsage(role)`) and that role's lifetime charges, so a reviewer
   run never counts against a worker turn or the reverse. The profile with the
   lowest use over its share goes first. The subscription group's recent count,
   across every role, breaks ties without deciding; lifetime role use over share
   comes next, then the group's lifetime count and the profile id. Every
   `chooseProfile` caller (first dispatch, revision source, failover, route,
   non-delivery route and transient resume) reads the same role-scoped counts
   from `store.rotationCounts(role)`.
5. If no profile meets the demand, keeps the most capable eligible profiles and
   rotates among them the same way; the board shows the shortfall
   ("demand Heavyweight, best available Worker").

An explicit request still applies under [Spec 052](052-usage-level.md)
sign-off; it replaces the demand result for that role.

- **Cross-host worker profile selection and availability** (Tom, 2026-11-19):
  worker selection, `route role=worker` (with or without `now`), `restart fresh`,
  Spec 052 step-up, worker failover, and signed-off worker profile requests
  evaluate launch eligibility across every online host catalog in the task's
  mode rather than stopping at the task's current host. Required worker profile
  availability counts every online host before raising a missing, disabled, or
  unavailable decision. When a chosen worker profile is launchable only on
  another online host, the worker dispatch or route moves the task to that host
  (recording `hostId` and `hostSelection` with `basis: "worker_profile"` per the
  [orchestration contract](../contracts/orchestration.md)) while preserving the
  task's branch and PR; non-worker roles remain on the task's current host.
- **The first-dispatch target kind is a requirement** (Tom's ruling, nucleus#1416,
  extended by Tom, 2026-11-20). The target is the repository's explicit
  `hostKind`, else the operator default. It must have an online host with a read
  catalog before an unbound worker is selected or committed; while it does not, the
  task keeps `Waiting for repository host <label>` (or `Waiting for operator default
  host <label>`) with no workspace, profile charge or slot, and healthy projects keep
  dispatching. An unregistered target reads as a configuration wait. A host outage is
  not proof a profile cannot run there, so the wait holds even when another host has
  it. Tom, 2026-11-20: when the global default names a host kind, first dispatch
  waits if that target is unavailable; a selected model can still run elsewhere when
  the target's healthy catalog positively shows it cannot launch there, as with
  Antigravity on a Paseo default. With neither configured, dispatch stays automatic.
  The target is read before selection and again before the commit, so a default that
  changes, or a host that drops, during admission holds the dispatch. The earlier
  cross-host ruling still holds for a profile only another host can launch while the
  target is ready, and its reason names the ready target's catalog as lacking it. A
  selection reason says "only" only when every registered host was read; a host that
  was offline or unread is named as not ruled out.

**What retires:** the pool's `roles` and `scopes` switches, and the soft
capability-fit multiplier (demand replaces it). A task's `scope` stays readable
history and no longer gates selection. The by-request flag that Decision 2
kept was retired on 2026-11-09 ([Spec 052](052-usage-level.md)): a frontier
capability now keeps a profile behind sign-off below Maximum.

## Visibility before rollout

The task detail shows each role's demand and the profile the formula would
pick now ("worker · demand Worker → Deepseek"), as a read-only
preview computed on the board from the pool, the catalog, the usage level and
the task (`shared/demand.ts`), before selection switched over. A shortfall is
shown in warning colour with the profiles a signed-off request could reach.
Tom reviewed the preview and approved the switch (2026-10-21: "Preview looks
fine for now. Go"); there is no Settings toggle, and the old weighted path is
deleted. Settings has no role or scope switches. Loading an older profile file
discards those fields in memory. The next settings edit that saves the file
omits them. Skills and supervisors are told only after the switch is live (the
"operator UI before agent rollout" rule).

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
   capability the work needs. (Superseded 2026-11-19: the usage level sets the
   reviewer's bracket; [Spec 052](052-usage-level.md).)
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
   (Retired 2026-11-19 with the brackets: no role has an offset.)

## Acceptance

| # | Case | Expected |
| --- | --- | --- |
| 1 | Complexity medium, Normal, worker | Every Worker profile rotates by weight share, none is starved; a review asking for changes never climbs past Worker |
| 2 | Complexity high, Normal, worker | Starts on Worker; after an applied changes-required review, climbs once to Heavyweight |
| 2b | Same task, reviewer, Worker author | Mechanical (one bracket below) at Low and Normal; on the author's bracket at High, Extra high and Maximum |
| 3 | Any complexity, coordinator | Mechanical when available, else the lowest permitted bracket with a profile |
| 4 | Complexity very_high, Normal | Starts on Heavyweight. Frontier requires an explicit request. |
| 5 | Same task at Maximum | Starts on Frontier; a medium task starts on Heavyweight and a low one on Worker |
| 6 | Same task at Low after an approved submission | Starts one bracket below the bracket it may climb to |
| 7 | Reviewer shares the author's model | Excluded, as today |
| 8 | Author escalation history (rows stripped 2026-11-09, task 989) | No demand change |
| 9 | Signed-off request | Used for that role whatever the demand |
| 10 | Older profile file carries retired membership fields | Loads without those fields. Dispatch uses capability and demand, and the next save omits them. |
| 11 | Two profiles at the same capability, weights More and Default | Share follows the stops (150:100); Most and Fewest give 200:50, so 160:40 over 200 picks |
| 12 | Same capability, equal weight, differently rated legacy costs | Equal rotation; the legacy cost is discarded on read |
| 13 | Unavailable subscription group in the set | Skipped; the rest of the set rotates |
| 14 | Worker `route` (`now` or queued), `restart fresh`, or required-profile check for a profile launchable only on another online host | Evaluates every online host catalog in the task's mode; raises unavailability only when no online host can launch it, and moves the task (`basis: "worker_profile"`) to the capable host while keeping branch and PR |
| 15 | Unbound worker on a repository with an explicit hostKind whose host is offline, reconnecting, or has no read catalog, while another online host has the profile | Stays queued with `Waiting for repository host <label>`, no workspace, profile charge or slot; a healthy project dispatches in the same pass; the same task dispatches through ordinary scheduling once the host answers |
| 16 | Same repository, the host drops between selection and commit, or the setting changes while queued | Commit holds before any intent; clearing the kind releases the wait on the next pass |
| 17 | Repository hostKind with no registered host of that kind | Visible wait `Repository host <label> is not registered; waiting for its configuration`; no workspace |
| 18 | Most-weighted profile with many reviewer runs, against a Fewer worker-only profile with a recent worker turn | Most is picked: reviewer runs never count against its worker rotation |
| 19 | Most against Fewer over 60 worker picks | Converges near 200:75, about 44 and 16 |
