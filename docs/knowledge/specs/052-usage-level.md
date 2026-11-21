# 052 — Usage level

This is a dispatch policy setting, not subscription usage monitoring. Provider
subscription displays belong to host apps and their plugins (Spec 059 is
retired).

Status: implemented
Owner: Nucleus runtime maintainers
Created: 2026-10-18
Decision owner: operator (Tom, 2026-10-18: "slide the slider all the way to the
right and the Queue will pick those models by default without having to ask for
it")
Governing refs: [Spec 030](030-routing-changes.md) (routing, cost and capability),
[orchestration contract](../contracts/orchestration.md) (frontier profiles)

## Problem

Frontier profiles are by request: automatic selection never lands on one, and
every role needs an explicit profile and reason. When the
operator has plenty of usage, for example free resets, asking per task is
friction. When usage is tight, nothing holds automatic selection to cheap
profiles.

## Rule

- **The profile list is Nucleus's own** (Tom, 2026-11-06: "have the host app
  provide a list of all the providers and models, then allow the operator to
  create profiles based on their selections"; 2026-11-07: the list set up in
  Nucleus is the one that is kept, and hosts may name a provider differently).
  Nucleus stores its own profile records — id, name, provider, model, mode,
  thinking level, feature values and notes — read and edited with
  `profile.list`, `profile.create`, `profile.update` and `profile.remove`. Each
  host reports what it can run through `host.catalog` (every provider, its
  models with thinking options, and the modes and feature values each model
  offers), in its own spelling.
- **One canonical vocabulary; each host translates it in code** (task 1158,
  Tom 2026-11-12: "It shouldn't touch the profiles themselves.. feels like we
  might just need to hard code the mapping that each host gives to each provider
  and have them converge on one canonical corpus that we use in the settings
  form"). `shared/profile-vocabulary.ts` owns the corpus: providers (`codex`,
  `claude`, `pi`, `grok` and the others hosts report), the provider's own model
  ids, one ordered thinking scale (`off` … `ultra`) and one set of runtime modes
  (`plan`, `supervised`, `accept-edits`, `auto`, `auto-review`, `full-access`).
  Feature values are the provider's own options. Profiles store only canonical
  values; create and update refuse anything else. A profile stores its thinking
  level once, in `thinkingOptionId`, and its mode once, in `modeId`
  (nucleus#1365, Tom 2026-11-19: "There should only ever be one field for this
  setting in the profile settings UI"): an option a host's table uses to carry
  either (a provider's `thinkingOption`, the host's `thinkingSelects` such as
  T3's `reasoningEffort`, a mode's option values) is never a feature field in
  the editor, which shows one Thinking and one Mode control in canonical values.
  A stored feature value on such an option makes the profile unavailable on that
  host with the reason named, and the migration below moves stored thinking
  carriers to the level. Each host adapter owns one
  table (`hosts/paseo/vocabulary.ts`, `hosts/t3code/vocabulary.ts`) that
  translates canonical values to its own: Paseo spells Claude's `full-access` as
  `bypassPermissions` and `supervised` as `default`, and carries Grok's
  `full-access` as its `auto_accept` option; T3Code names Claude `claudeAgent`
  and carries its thinking as the `effort` option (`ultra` is `ultrathink`) and
  Pi's as `thinking`. Provider options also have canonical keys (nucleus#1386,
  Tom 2026-11-19: the Astra profile's `service_tier` "is the same setting as
  'speed' in paseo"), stored in `featureValues`: `speed` (`default`, `priority`,
  `ultrafast`) is Paseo's codex `service_tier` and claude `fast_mode`, and T3's
  codex `serviceTier` and claude `fastMode`; `plan-mode` (Paseo codex
  `plan_mode`), `cyber-access` (T3 codex `cyberAccessProgram`) and `ultracode`
  (T3 claude `ultracode`) are single-host options kept for their defaults. Each
  table's `options` spell them; the editor shows one canonical control per option
  and none of the host spellings. A canonical option at its default is the
  provider's own default and is never sent, so it runs on every host; a
  non-default value a host's table can't spell (T3 has no ultrafast tier) or a
  model doesn't offer makes the profile unavailable there with the reason
  (`T3Code can't express speed Ultrafast for codex`), so selection excludes it
  and the pre-send check stays drift protection only. A value a host's table can't express makes the profile
  unavailable on that host with the reason computed (`T3Code can't run codex in
  mode plan`); nothing is configured per profile. Selection marks a profile
  unavailable when its requested thinking level is absent from the host catalog.
  If that catalog changes between selection and T3 launch, the adapter instead
  chooses the nearest supported canonical level from the launch snapshot, with
  ties going lower; it can choose a higher level, and refuses before send if no
  level can be carried. This handles catalog drift without selecting a profile
  already known to be unsupported. Each
  host's routing snapshot carries the translated launch values, judged against
  that host's catalog, and a profile edit rebuilds the snapshots from the
  catalogs already read. `profile.compatibility` answers, for every stored
  profile and every known host, `works`, `unavailable` or `unknown` (catalog
  never read) with the reason naming the host, the fields that host spells
  differently and the values a launch there sends; `routingPolicy.host.effects`
  lists each enabled profile a task's host rules out or translates.
  Pool saves (`queue.profile`, `queue.pool`) check identity against the stored
  profile records, never the routing snapshot, which is empty until a host
  catalog is read (nucleus#1492). A stored profile saves with or without a
  catalog read, and the catalog still alone decides whether it can launch on a
  host. A new or changed entry naming no stored profile is refused as `Unknown
  profile <id>`; an unchanged entry for a removed profile is kept as inert.
  Duplicate and reserved-group checks are unchanged.
  `profile.vocabulary` answers Settings' form: every registered host's catalog in
  canonical values, merged, so each dropdown offers what at least one host can
  run. Settings → Profiles edits canonical values only; a row shows one quiet
  warning icon when Nucleus serves more than one host and the profile can't run
  on one, with each host's reason in its popover. Stored profiles moved to the
  canonical vocabulary once on open (`profileVocabularyMigration` records what
  changed); a profile with a value the migration doesn't know is left as stored
  and reported. On every open the service then moves a thinking level held in a
  host carrier (`featureValues.thinking`, `effort`, `reasoningEffort`,
  `reasoning`) or a host spelling in `thinkingOptionId` (`ultrathink`, BB's
  `none`) to the canonical level, read back through every host table
  (`hosts/vocabularies.ts`); `profileThinkingMigration` records the first run and
  any run that changed a profile. The same way, host spellings of a canonical
  option (`service_tier`, `serviceTier`, `fast_mode`, `fastMode`, `plan_mode`,
  `cyberAccessProgram`, a boolean `ultracode`) move to the canonical key, keeping
  their meaning; `profileOptionMigration` records it. A value no table maps, or two values that
  disagree, stays as stored and reported, and shows on the profile as that host's
  reason. The task card reads a routing snapshot's level back through its host's
  table, so it shows the canonical level, not the host's spelling. The per-profile host setting (nucleus#1151) and the provider map
  (2026-11-08) are retired.
- The
  earlier migration copied Paseo's `config.agentProfiles` once with
  ids unchanged and records that it ran, so the pool, routing requests, grants
  and history keep matching; a Nucleus profile is never overwritten and a later
  Paseo change imports nothing. Availability is read from a stored profile and
  one host catalog, with no silent fallback: a host lacking the provider or model
  makes the profile unavailable with a plain reason. Settings → Profiles is the
  picker (Tom, 2026-11-06: "show whatever the host reports. We need to be able to
  control permission settings and agent-specific modes"): it creates, edits and
  removes the stored records, showing each one's availability and plain reason
  on this host, and a new profile picks a provider and model from the host
  catalog, then a mode, a thinking level and that model's feature values, plus a
  name and notes. The catalog is read for a configured repository directory,
  because the host resolves feature values per working directory. Routing reads
  the stored records and the host catalog.
  Options don't vary by host (Tom, 2026-11-07: "Let's go with no for now and look
  at it again if the need arises").

The operator sets one host-wide usage level on a five-stop slider (Settings →
Dispatch limits, or `queue.usage`): **low, normal, high, extra high and maximum**
(Tom, 2026-11-17; `minimal` is removed). The level carries an optional end time
when it returns to Normal, picked from a calendar in local time. Settings offers
the end time above Normal (High, Extra high and Maximum), as small text on the
section's heading row ("No end" or "until <date>"), and moving to a lower level
clears it (Tom, 2026-11-09). Dispatch limits has no save
buttons: the level, its end time, task slots and project overrides
save as they change, an invalid value is not sent, and each section shows
a brief Saved or the reason it was not saved (Tom, 2026-10-22; Saving… stays quiet, Tom 2026-11-08).

Profile capability is four brackets (Tom, 2026-11-19: "a simpler 4 point
bracketing system … essentially we're just combining medium and high to create
a pool of workers"). Task complexity keeps its own five-point scale.

| Bracket | Was |
| --- | --- |
| **Mechanical** | `low` |
| **Worker** | `medium` and `high`, one pool |
| **Heavyweight** | `very_high` ("extra high") |
| **Frontier** | `frontier` |

"The top two" are Heavyweight and Frontier. The store moved stored values once
(nucleus#1385); the migration is idempotent and lists any value it doesn't
know, leaving it as stored.

A task's **own bracket**: very-low and low complexity are Mechanical, medium
and high are Worker, very high is Heavyweight. The bracket it **may climb to**
is its own, one higher for high and very high: the medium/high difference is
the step-up (Tom, 2026-11-19: "a medium complexity task goes to a Worker
profile, a high complexity task starts on a Worker but can escalate to a
Heavyweight if it needs to").

| Level | Where a task's worker starts | Permission |
| --- | --- | --- |
| **Low** | One bracket below the one it may climb to. | High and very-high complexity work needs permission at submission: a decision opens on the board and the task is held until the operator approves. Once approved, the Low rules apply. Frontier needs permission; Heavyweight does unless the task starts or climbs there. |
| **Normal** (default) | On its own bracket: Mechanical, Worker or Heavyweight. | Frontier needs permission; Heavyweight does unless the task starts there (very high) or climbs there (high). |
| **High** | At the bracket it may climb to, up to Heavyweight. | Frontier needs permission. |
| **Extra high** | As at High. | None. |
| **Maximum** | Workers and reviewers run on Heavyweight or Frontier regardless of complexity. | None. |

- **Above the climb bracket.** A worker run above the bracket the task may
  climb to is an explicit planner or operator route, never automatic.
- **Step-up.** When an applied review requests changes on a task that started
  below the bracket it may climb to, the next worker run climbs one bracket,
  never past it: a medium task stays on Worker, a high task climbs once to
  Heavyweight, a very-high task climbs to Frontier under the level's
  permission rule (sign-off at Low, Normal and High; automatic at Extra high
  and Maximum; planner correction, question 10020177), and very-low and low tasks stay on Mechanical. The applied review outcome
  (`resolution.review.status === "changes_required"`) authorizes it, never the
  `changes_requested` phase alone (an owner move or recovery also takes that
  phase), and one climb is recorded per review run
  (`resolution.workerClimb`). A retained worker thread cannot change profile, so
  the climb is the one automatic worker replacement: the ordinary revision
  launch records the climb, retires the retained worker (for the archive sweep),
  and continues as its usual revision run on a fresh agent at the climbed
  profile; delivery binds that agent and run as the task's retained worker,
  keeps the selected subscription group on both the run and the task, and
  charges that fresh binding's assignment, so a later same-bracket revision
  continues it. A retained revision, re-review or coordinator turn keeps its
  thread and charges nothing: the rotation history counts fresh and explicitly
  selected bindings only. The climb is recorded before the launch
  so its bracket stays permitted, and the `changes_requested` phase alone never
  authorizes it. Request reconciliation (`reconcileRoutingSignoffs`) and route
  admission read the same recorded climb, so a request or route at the earned
  bracket needs no second sign-off; the same-capability non-delivery and rate-limit
  replacements read it too, so an eligible alternate on the earned bracket is not
  discarded. Climbing to Heavyweight never needs permission; going above the
  climb bracket is an explicit planner or operator route.
- **Automatic selection stays at or below the climb bracket.** The run's
  bracket is its demand: it rotates inside that bracket, takes the nearest
  bracket above only when nothing carries it, and falls back to the most
  capable profile at or below the climb bracket on a shortfall. A profile above
  it is never automatic for a worker, and neither a worker preference nor a
  `preferredProfileId` reaches it; only an explicit request or owner route
  does. Maximum's own rule is Heavyweight and Frontier for workers and
  reviewers, an explicit worker request included, and an unrated retained
  reviewer is below it too.
- **The usage level sets the reviewer's bracket** (Tom, 2026-11-19: "the
  reviewer should be 1 bracket down from the worker on minimal, low and
  normal. Above that, it should be same bracket"). At Low and Normal the
  reviewer runs one bracket below the worker's actual profile (its start
  bracket before a worker ran): Heavyweight → Worker, Worker → Mechanical,
  Frontier → Heavyweight, and a Mechanical worker gets a Mechanical reviewer.
  At High, Extra high and Maximum it runs on the worker's bracket. No reviewer
  floor parks review: when no independent profile carries the reviewer's
  bracket, the nearest permitted bracket above serves, and otherwise the most
  capable permitted profile. A critical task prefers a reviewer at least as
  capable as the worker when one is permitted, and falls back the same way
  (kept by Tom, 2026-11-19). At Maximum reviewers still use Heavyweight and
  Frontier.
- **Nothing waits for an escalation sign-off** except the Low submission gate.
  A role whose preferred profile needs permission runs on the best allowed bracket
  while the decision is open on the board, as before.
- **Other roles.** Reviewers keep the independence rule, and a retained
  reviewer below the bracket the level asks of it is replaced on the next
  round. Coordinator and recovery runs always use Mechanical when an eligible
  Mechanical profile is available, and otherwise the lowest permitted bracket
  that has one, at every level including Maximum (Tom, 2026-11-19: "Coordinator
  should always be mechanical if available, worker shouldn't have an offset at
  all"). There are no role-demand offsets: the Settings section is gone and the
  store drops a stored `demandRoleOffsets`, noting it in the migration record.
  Deciders run on the task's own bracket (nucleus#1362).
- **Eligibility** (Tom, 2026-11-09). Automatic selection may use a profile when
  its capability bracket and its On/Off switch allow it at the level in force,
  nothing else. Outside that, a profile needs an explicit request with a reason
  and sign-off. Profile cost is retired and the rotation weight is a five-stop slider
  ([Spec 053](053-demand-based-selection.md), Tom, 2026-11-21); neither is ever a
  permission rule.
- **Cost removed, Weight a slider** (Tom, 2026-11-21). The profile Cost rating
  is gone now that capability brackets decide eligibility; no routing, sign-off
  or recovery path reads it. Non-delivery routing and transient rate-limit
  failover no longer filter on it, and a coordinator `route` is checked only
  against the level's permission rule. Saved profiles read their legacy Cost
  and integer weight at the existing boundaries (Spec 053 states the mapping);
  the Cost value is discarded.
- **Frontier is a capability bracket, not a cost** (Tom, 2026-11-09: "Can we
  get rid of very low, and instead add `frontier` to the other end of the
  scale?… then Opus would move to `frontier` to distinguish it better from
  Sol"). The 2026-10-01/15 rule that very_high cost meant frontier is retired.
- **The Low submission gate** (Tom, 2026-11-17). Submitting a high or very-high
  complexity task while Low is in force opens one operator decision linked to
  the task and places a dispatch hold naming the level and the complexity. The
  gate is decided at admission: `store.insert` records it only when the level in
  force then is Low and the complexity qualifies, so work submitted earlier or
  already running when the level changes is never held. If the task already
  carries a board or planner hold, the gate opens its question beside it and
  places no fence of its own; later approval clears only a fence the gate
  placed. The task does not dispatch until the decision is approved on the
  board; a relayed answer does not approve it. A decline keeps the hold, and the
  owner's exit is lowering the complexity (`set_routing`) or raising the level,
  either of which withdraws the question and clears the gate's own fence.
- **By request is retired** (Tom, 2026-11-09: "Retire it, fold into #1002";
  earlier the same day: "lift it at maximum slider? That's sort of the point of
  that slider setting"). The pool's `byRequest` flag, its toggle and its row
  status are gone; the store drops stored flags on open, and a pool write that
  still carries one reads without it. Requests and grants still work for any
  profile the level's permission rule holds.
- **Preference.** The level sets each run's start bracket, not a weight: since
  [Spec 053](053-demand-based-selection.md) (Tom, 2026-10-21; 2026-11-04) the
  set is every profile rated at or above the demand, with rotation and fair
  share inside it, weighted by the five-stop weight share (80% to 120% of Default, Tom, 2026-11-21), which never removes a profile. The
  2026-10-18 soft leans and tier orders are retired. An unavailable
  subscription group leaves the set; when nothing meets the demand, selection
  takes the most capable eligible profiles.
- **Roles.** The level applies to every automatic selection: worker, reviewer,
  coordinator and replacements. Review independence is unchanged; the reviewer
  still excludes every author model.
- **Coordinators.** A coordinator's `route` is refused to a profile the level's
  permission rule holds: Frontier, or a Heavyweight profile the task neither
  starts nor climbs on, at Low or Normal, or a Frontier profile at High.
- **Explicit requests and sign-off** (Tom, 2026-10-21: "fully bound by
  default, but allow explicit override with reason _and_ sign off from me").
  A request (`profileRequests`, owner or coordinator `route`, `set_routing`)
  for a profile the level's permission rule holds applies only
  once the operator signs it off on the board or through their authenticated T3 session. Nucleus asks through an operator
  decision linked to the task, on the requester's behalf: approve the
  requested profile, pick another from the role's pool, or decline. A required
  legacy worker preference for such a profile enters the same request and
  decision lifecycle before dispatch; it grants no sign-off by itself. Nothing
  waits for the answer (Tom: "don't hold things up"): an unsigned request pins
  nothing, sets no thinking level and never leaves a role waiting, so the role
  runs on automatic selection within the level. When an approval arrives, Nucleus
  applies it through `route`: a live role run that was selected automatically
  while the request awaited sign-off is replaced on the approved profile, and a
  role with no live run (including a worker that has handed over to review) gets
  the route for its next run. Workspace and branch stay in place. The replacement
  ceiling and worker replacement guard still apply; if they refuse a live worker
  replacement, the approved route is saved for the next run and the activity
  records why the live run stayed. A decline leaves the run alone. Only a direct operator answer on the board or in T3 counts; a relayed answer, a withdrawal or an answer that names no option
  declines, and the requester gets the answer as for any decision. The
  operator's own board `route` or `set_routing` is its own sign-off. An
  approval already given for a task and profile is not asked again: a
  re-recorded request for the same role and profile restores the recorded
  approval instead of opening a new decision, while a later ruling for the
  same role and profile wins. A recorded selection that predates a required
  approved route yields to it from that role's next run: the next worker run
  is replaced onto the approved profile and a stale reviewer or coordinator
  binding is dropped, without stopping a live run. A route
  that replaces the request withdraws the open question; a finished task
  withdraws its open ones; a level that later covers the profile withdraws it
  as moot. `route now` to an unsigned request-only profile is refused, since it
  would only restart the role on automatic selection. Requests on live tasks
  when this shipped were bound too, each opening its own question (Tom: "Bind
  them too"). A request within the level needs no sign-off. A worker already
  bound to its task keeps its own thread on its profile until the task ends
  (Tom, 2026-10-21: "Keep its thread"); a live run and a review continuation are
  never stopped by sign-off. Every new selection is bound: a fresh reviewer on
  the recorded reviewer profile, a new run on the bound coordinator, and new or
  replacement workers. The answer maps through the options as they were asked,
  and an unsigned worker route keeps its thinking level on the request. Submissions never
  carry a sign-off; Nucleus writes it. `routingPolicy` rows show each request's
  sign-off state. Spec 058 cutover 3 retired every other automatic author capability upgrade: apart from the one review-authorised step-up above, a stronger worker model requires an owner route and the usual sign-off.
- **Planner grants** (Tom, 2026-11-06: when frontier is needed it is generally needed for a string of dispatches; agents ask and handle the routing, the operator only says yes). A planner requests a standing grant with `queue.routing-grant` action `request`, naming why and optionally which profiles and until when. Nucleus opens one operator decision on the existing board. A direct operator yes on the board or in T3 activates the grant; a relayed answer does not. A repeat request while one is open joins it; a planner with an active grant is told so. Only a direct operator answer activates a grant: an agent cannot grant itself or another. While the grant stands, an explicit `profileRequests` or `route` on a task whose owner is that planner is treated as signed off, with the grant ID recorded on the request and in `routingPolicy`, and no per-task decision. Requests the grant does not cover — another planner's task, automatic selection, a profile outside a named set — keep today's route. The grant does not move automatic selection or demand. Coverage follows the current owner: a reparented task is covered only while its owner is the granted planner; reparenting away clears a grant-based sign-off, so the next fresh run falls back unless the new owner has a covering grant or a true operator per-task sign-off. The planner ends the grant with action `end`. The operator revokes from Settings → Limits at any time. An optional `until` expires it. An archived planner thread ends it. Revoking, ending, expiry and archive stop new sign-offs at once, are idempotent, and record the time. A covered request then remains on automatic selection without a new per-task decision; `routingPolicy` names the ended grant. A new grant or a fresh explicit request after the end enables frontier again. A task already running on the profile finishes that run; its next fresh run falls back. Open per-task decisions the new grant covers settle themselves; an explicit per-task decline stays declined, including if the planner resubmits or routes the same request while a grant stands. Without a covering grant, resubmitting a declined request is unsigned and opens a fresh per-task decision (today's route). Restart keeps stored grants. Settings → Limits lists active grants (planner, profiles, since when, run count) with a revoke control, never the board header (Tom, 2026-11-06); `next` says a request was covered by a grant. Run count increments for each fresh dispatch under the grant: the initial worker at `dispatch_intent`, and each new reviewer, worker-revision, or coordinator-route (recovery, verification, closeout) run on first `putRun`. Wake inventories live agents to archive a grant only when one is pending or live, bounded to 10s; a truncated or failed inventory leaves grants standing. Board projection reads live grants without persisting expiry; reconcile still writes expiry so covered sign-offs clear.
- **Expiry.** `until` returns the level to Normal when it passes. Settings shows
  which level is in force, and when a set level has expired. The board
  re-projects once when the level in force changes, so an open Settings screen
  never keeps showing an expired level.
- **Diagnostics.** When the level's permission rule, not the pool, leaves a
  role with no profile, the wait says so: it names the bracket the level holds
  selection below, and says to raise the level or `route` the role. A catalogued
  profile the eligible set filtered out is reported as filtered, never as
  missing: excluded for this task, sharing the reviewer's model, or filtered
  from the eligible set; only a profile outside the catalog is absent. The wait stays a
  verb-free `route_unavailable` wait, since a coordinator cannot route past the
  level's permission either; `next` offers the owner `route`.
- **Effective policy on reads.** Tom chose this explanation as the Nucleus
  priority on 2026-10-19 (decision 83556116; papercut b6804a4b): an owner read
  a stored flag as absolute and rerouted a correct automatic Maximum pick.
  Reads show the policy in force, derived from the selector's own
  `requestOnly`; no gate or setting changes.
  - `task.next` and `queue.detail` carry `routingPolicy` (a recorded row that still carries the retired `cost` reads without it, nucleus#1488): the dispatch-level policy, and
    one row per profile the task names (worker request, worker preference,
    recorded worker or reviewer run, reviewer and coordinator requests). Each
    row has `capability`, `automatic` (`allowed`, `request_tier` when the
    level's permission rule holds the profile, or null outside the pool), its pool `gates` (disabled,
    group unavailable) and an `explanation`. A request stays
    explicit at every level; a preference alone does not satisfy a request
    requirement; a recorded run is history, not relabelled by today's level.
    Catalog availability is checked at dispatch, not here. Both reads compute
    it fresh, including over a cached detail payload, so expiry shows at once.
  - The board's Next section lists those rows; route and routing profile buttons
    tag the effective policy, and the chosen profile shows its full sentence.
    The route chooser offers every enabled profile (Spec 053 retired the role switches); a profile that fails a
    pool gate (disabled, the same check a route refuses on) reads
    "not eligible" with its cause, never "automatic". A profile whose
    subscription group is unavailable reads "group unavailable" in both
    choosers, with the reason and reset time once chosen. Long labels wrap.
    Settings → Profiles rows show a status only for a problem (unavailable, or
    a paused subscription group); the capability control shows the four
    brackets, and its (?) says where each complexity starts and which brackets
    need permission.
- **Normal.** Normal starts every task on its own bracket.
