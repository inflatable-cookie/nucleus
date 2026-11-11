# 030 — Changing a task's routing without superseding it

Status: implemented
Owner: Nucleus runtime and UI maintainers
Created: 2026-09-28
Decision owner: Tom (request relayed by the Nucleus Chatterbox, 2026-09-28)
Governing refs: [orchestration](../contracts/orchestration.md), [Spec 003
disposition](003-post-dispatch-task-disposition.md), [Spec 026 planning
records](026-planning-records.md), nucleus contract 002 (mirrors this spec)

After worker intent, routing changes go through `reassign_roles`
([Spec 036](036-role-reassignment.md)).

## Problem

A task's routing (its capability, preferred profile, whether that preference is
required, thinking option and per-role profile requests) is fixed at submission.
On 2026-09-28, nucleus#036–#038 sat queued with "No eligible worker profile": one
required profile's group had run out, and another required Sol for `general` work
that Sol isn't enabled for. No control could change routing, so all three were
superseded and resubmitted as #039–#041. That meant new task numbers and new leads,
and one dependency had to be re-pointed by hand.

After dispatch the same need appears in replacement: `replace_stopped_revision` and
`replace_stopped_worker` pick any eligible profile except the stopped one, and
cannot be steered to a stronger model (nucleus#033, 2026-09-27).

## Outcome

- **`set_routing`**, a versioned operator control on `queue.task`:
  `{taskId, version, reason, scope?, complexity?, preferredProfileId?, requirePreferred?,
  thinkingOptionId?, profileRequests?}`, with at least one routing field. It
  replaces the named fields and leaves the others as they are. `profileRequests`
  takes the submission shape (`worker`, `reviewer`, `coordinator`, each
  `{profileId, reason, required}`), and `null` for a role clears it. `complexity`
  takes `null` to clear. The pre-rename `capability` key is refused with a
  message naming `scope`.
- **When it applies:** only before the worker exists, meaning no worker agent
  intent and no worker agent. That covers queued tasks, including those waiting
  on dependencies or capacity, and `needs_attention` before dispatch. After
  dispatch it's refused with a message naming the replacement controls. The
  same pre-worker-dispatch fence applies to reviewer and coordinator requests.
- **Validation matches submission:** every named profile exists in the live
  catalog and is enabled in the pool (Spec 053 retired the role and scope
  checks). A request needs a non-empty reason (the by-request flag is retired,
  [Spec 052](052-usage-level.md)). From the CLI, `note` is required and names the
  operator's authorization; it is recorded as relayed, as `lead.approve` is. The
  board's action is the operator's own. An unavailable group is allowed, since
  availability changes; the change is recorded with a warning.
- **Recording:** one `routing_changed` event with the before and after values
  and the reason; the task version goes up. The brief, its digest, the task
  identity, number, dependencies and lanes are unchanged. The next dispatch pass
  re-evaluates eligibility. The outcome row records the routing the task finally
  ran with.
- **Replacement takes a profile:** `replace_stopped_revision` and
  `replace_stopped_worker` accept an optional
  `profile: {profileId, reason}` for the replacement worker. It must differ from
  the stopped profile and passes the same validation. Without it, selection works
  as today.
- **Replacing a responsive retained worker** (2026-09-28, project-a #1671): operator
  `replace_retained_worker` `{taskId, version, instruction, profile?}` applies
  between runs to an unmerged task with a PR, meaning no current or unreleased run
  and no merge intent, when the retained worker keeps reporting but can't finish.
  It retires that worker through the existing remap path, excludes its profile
  unless a different `profile` is named (validated as above), and continues on the
  same task, workspace, branch and PR with the instruction. The stopped-worker
  controls stay for stopped workers; this one never applies to a live run.
- **Remapping an ineligible retained worker profile:** operator
  `retry_resolution` applies when a retained revision stops in attention because
  its worker profile is unavailable. It remaps to an eligible worker profile on
  the same task, workspace, branch and PR. Its optional `instruction` replaces
  the latest pending worker continuation; without one, Nucleus uses the newest
  `worker_resume_requested` or `revision_requested` detail. Its optional
  `profile: {profileId, reason}` selects the replacement profile, which must
  differ from the retained profile and pass the replacement eligibility and
  subscription availability checks above.
- **Authorization on replacement controls** (clarified 2026-09-28):
  `replace_retained_worker`, `replace_stopped_worker` and `replace_stopped_revision`
  take no `note`; Nucleus refuses it with "Authorization note is only valid for
  set_routing". The authorization and the reason for a chosen profile go in
  `profile.reason`, and may be repeated in `instruction`. Only `set_routing` carries
  the relayed `note`.
- **Diagnostics:** "No eligible worker profile" names why each pool candidate
  failed: group unavailable (with its reason and retry time), disabled,
  above the cost ceiling or frontier below Maximum without a signed-off request, thinking option
  unsupported, or preference required but ineligible. The list is bounded, with
  the most specific causes first.
- **Board:** task detail offers "Change routing" on tasks where `set_routing`
  applies. It shows the current routing (scope and complexity) and the enabled
  profiles, tags request-only profiles, offers a complexity
  picker with an unset state, and requires a reason.

## Independent-review routing preflight (Tom, 2026-10-12)

Tom: "If Queue won't run tasks with the same reviewer as worker then that needs
to be validated on promotion, not at run time." A required worker/reviewer pair
that names the same profile, or distinct profile IDs that normalize to the same
actual model, is refused before Ready/approval, again at source promotion and
every other admission seam that accepts explicit routing, and before any task
binding or workspace/worker intent. The same canonical model-identity rule as
runtime selection applies (`modelKey`: last path segment, lower-cased). A
worker `profileRequests` entry takes precedence over `preferredProfileId` /
`requirePreferred`, matching selection.

The refusal names the conflicting roles and models and tells the caller to
choose independent routing. It is never the generic runtime "No eligible
independent reviewer" line. Optional or fallback requests still pass when
another independent catalog route exists. A missing or opaque
(`provider/default`) required identity fails closed. Temporarily exhausted
subscriptions are not treated as a permanent identity conflict; eligibility
authority stays at dispatch. Review entry applies the same check to declared
author models. Existing queued and dispatched tasks are not auto-mutated.

Runtime selection and the adapter independence guard still re-check after
admission, because the actual author or catalog can change. No new review skip
or task-author rewrite is added.

## Capability ratings and task complexity (Tom, 2026-10-12)

Tom asked for a five-value capability rating on queue agent profiles that
mirrors `cost`, an optional matching complexity on every task, and automatic
model choice weighted so the rated capability sits close to that complexity.
The owner interpretation recorded with the request renames the existing field:
the task-type scalar was `capability` and the pool list `capabilities`; those
names now belong to the ordinal rating, so current writes use task `scope`
and pool `scopes`, and `capability` means the new five-level rating.

- **Fields.** `capabilityLevelSchema` is `very_low | low | medium | high |
  `very_high`` (ascending). A pool entry takes optional nullable `capability`
  beside `cost`; a submission/task takes optional nullable `complexity` with
  the same values. Ratings are never inferred from a model name, cost or
  notes, and live profiles are never rated automatically. `cost` stays purely
  informational and never becomes a routing price.
- **Scoring policy** (retired 2026-10-21 by [Spec 053](053-demand-based-selection.md), which rotates among every profile meeting the run's demand, leaning toward cheaper ones instead). After hard eligibility and before automatic choice, each
  candidate's effective weight is multiplied by a documented linear fit:
  `capabilityFitMultiplier(complexity, capability) = 1 + 1 − (1 + 0.5) ×
  distance/4` — an exact fit doubles the effective weight (×2), the farthest
  known fit halves it (×0.5), and each ordinal step moves the multiplier a
  quarter. The multiplier folds into the same recent-share sort as the
  configured weight; rotation, fair-share, group pacing and the profile-id
  tie-break are unchanged. This is a soft preference in the UI's wording —
  never a guarantee, never an authority, and never a gate: a mismatched
  profile with no recent use still beats a heavily used near fit, so no
  rating starves. Explicit eligible preferred/required requests win before
  any fit is applied.
- **Unset.** Under Spec 053 an unset complexity, capability or cost counts as
  `medium`. `complexity: null` on `set_routing`
  clears; editing complexity affects future selection only and never
  replaces a running worker or reviewer, invalidates a review, or touches
  authenticated approvals.
- **Naming compatibility.** Stored rows, brief/handoff/draft frontmatter, durable
  operation payloads and pool settings keep their original bytes. Read and import boundaries rename the legacy keys —
  submission/task `capability` → `scope`, pool `capabilities` → `scopes`,
  outcome `routing.capability` → `routing.scope` — and refuse a record that
  carries both spellings. New writes emit only the current names; `set_routing`
  refuses the legacy `capability` key with a message naming `scope`, and takes
  `complexity` as a routing field. Telemetry filters and groups name the task
  type `scope`.
- **Boundaries.** No capability threshold or frontier activation: ratings do
  not change pool eligibility, subscription/group gates, review independence
  or declared/actual author exclusion. Profile metadata stays a Nucleus-owned
  pool setting, not a Paseo global profile API change.

## Acceptance

| # | Scenario | Required result |
| --- | --- | --- |
| 1 | Queued task with a required profile whose group is exhausted; `set_routing` to another eligible profile | Accepted; event records before, after and reason; next pass dispatches to the new profile; task number, brief digest and dependents unchanged |
| 2 | `set_routing` changing scope and preferred profile together | Validated against the new scope; accepted only if the profile has it |
| 19 | Task `complexity` from `very_low` to `very_high` against a five-level rated pool under equal usage | Each exact fit wins; an invalid complexity is refused |
| 20 | Known mismatch with no better-rated eligible profile | Still selected; rotation over many assignments reaches every rating without starvation |
| 21 | Unset ratings/complexity, unknown ratings, explicit requests, and all hard gates | Order reproduces the previous selection bit for bit; requests win; disabled, wrong-scope, by-request, unavailable and independence gates are unchanged |
| 22 | `set_routing` with the legacy `capability` key, and with `complexity` set then cleared | Legacy key refused naming `scope`; complexity stored, recorded in the event, cleared by `null` |
| 3 | By-request profile with and without a reason; CLI with and without `note` | Reason required; CLI without note refused, with note recorded as relayed; board recorded as operator |
| 4 | `set_routing` on a dispatched task, and with a stale version | Refused, naming the replacement controls; stale version refused |
| 5 | `replace_stopped_revision` with `profile` naming the stopped profile, an ineligible profile, and an eligible stronger profile | First two refused; third replaces onto exactly that profile, keeping PR and workspace |
| 6 | Queued task with no eligible profile for mixed reasons | Reason names each cause, bounded |
| 7 | Board "Change routing" in the installed bundle, dark theme | Offered only where it applies; lists eligible profiles; requires a reason |
| 8 | Restart between acceptance and dispatch | The routing change, event and outcome routing survive |
| 9 | Retained worker profile is unavailable; `retry_resolution` includes a fresh instruction and optional replacement `profile` | Attention text and notice name `retry_resolution`; the instruction replaces the newest pending continuation; the eligible named profile is selected |
| 10 | Required worker and reviewer name the same profile | Lead check fails before Ready; promotion and direct submission refuse before a task or workspace exists; the error names both roles and the shared model |
| 11 | Distinct profile IDs whose normalized models match | Same refusal as row 10, naming both profiles and the shared model |
| 12 | Required worker and reviewer name distinct independent models | Check, promotion and submission proceed |
| 13 | Optional or fallback request that still has an independent catalog route | Not refused as an identity conflict |
| 14 | Worker `profileRequests` versus `preferredProfileId` / `requirePreferred` | The worker request wins, matching selection |
| 15 | Required profile missing from the catalog, or using an opaque provider-default model | Fail-closed with that honest reason |
| 16 | The only other independent profile's subscription is exhausted | Not an identity conflict; eligibility stays at dispatch |
| 17 | Catalog identity changes between a passing Ready check and promotion | Promotion refuses; no task is bound; the approval remains |
| 18 | Review entry whose required reviewer shares a declared author model | Preview and bind refuse; no initial worker is created |
