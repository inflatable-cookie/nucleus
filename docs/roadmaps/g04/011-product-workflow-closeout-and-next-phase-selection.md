# 011 Product Workflow Closeout And Next Phase Selection

Status: completed
Owner: Tom
Updated: 2026-07-07

## Purpose

Close out the g04 vertical slice and choose the next high-level phase from
evidence.

G04 has now proven the product-shaped workflow from project/task inspection
through planning context, selected-task guidance, task command admission,
refreshed command outcome evidence, review/next-step presentation, and SCM
handoff readiness. The next step should not be another narrow subsystem lane by
habit. This lane records what the slice proves, what still blocks a usable
product, and which deferred or next-generation lane should come next.

## Governing Refs

- `docs/roadmaps/g04/001-product-workflow-rebaseline-and-vertical-slice.md`
- `docs/roadmaps/g04/010-selected-task-scm-handoff-readiness.md`
- `docs/roadmaps/deferred-lanes.md`
- `docs/roadmaps/long-term-plan.md`
- `docs/contracts/007-server-boundary-contract.md`
- `docs/contracts/023-task-backed-agent-workflow-contract.md`
- `docs/contracts/025-goal-loop-next-task-contract.md`

## Goals

- [x] Inventory what the g04 vertical slice now proves end to end.
- [x] Compare remaining gaps against deferred lanes and the long-term plan.
- [x] Decide whether the next phase should be g04 continuation, g05 rollover,
  memory/planning active apply, provider expansion, SCM execution, panel/UI
  foundation, or a health/reset lane.
- [x] Leave a bounded next-lane runway with ready cards.
- [x] Avoid reopening provider execution, SCM/forge mutation, accepted-memory
  active apply, planning active apply, panel layout, plugin runtime, or final
  UI without explicit product need.

## Execution Plan

- [x] Batch 1: g04 vertical-slice evidence inventory.
- [x] Batch 2: deferred-lane and gap comparison.
- [x] Batch 3: next-phase decision and runway compilation.
- [x] Batch 4: validation and handoff checkpoint.

## Batch Cards

Ready cards:

No ready cards. This roadmap is complete.

Planned cards:

No planned cards. The next implementation lane is tracked in
`012-selected-task-review-decision-controls.md`.

Completed cards:

- `batch-cards/050-g04-vertical-slice-evidence-inventory.md`
- `batch-cards/051-deferred-lane-gap-comparison.md`
- `batch-cards/052-next-phase-decision-runway.md`
- `batch-cards/053-product-workflow-closeout-validation.md`

## Evidence Inventory

The g04 vertical slice now proves these product surfaces:

- project workflow summary over existing project, task, planning, runtime,
  review, SCM, and next-step records
- source composition that explains planning context, memory/research context,
  runtime evidence, review state, SCM readiness, and product next step without
  creating new authority
- selected-task workflow drilldown that brings task identity, readiness,
  timeline refs, work-item progress, runtime receipt refs, review refs, SCM
  handoff refs, gaps, and no-effect flags into one server-owned read model
- selected-task work-loop guidance that turns drilldown evidence into a
  read-only safe-action explanation
- selected-task action readiness that separates allowed, blocked, and
  not-applicable action families without scheduling agents or mutating state
- selected-task operator action gate that exposes task-command candidates while
  leaving provider execution, delegation, review decisions, SCM/forge,
  memory, and planning paths read-only or deferred
- selected-task task-command admission and execution refresh for task-only
  commands, including revision gates, command receipts, timeline refresh, and
  stale-client protection
- selected-task review/next-step presentation showing review state, evidence
  boundary, gaps, and pathway-backed next step without review acceptance
- selected-task SCM handoff readiness showing provider-neutral target shape,
  readiness state, evidence counts, blockers, source counts, next step, and
  no-effect flags without SCM or forge mutation

Reusable server-owned surfaces:

- product workflow summary
- task workflow drilldown
- selected-task action readiness
- selected-task operator action gate
- selected-task command admission
- selected-task review/next-step read model
- selected-task SCM handoff readiness
- serialized control DTOs, `nucleusd` query surfaces, and Effigy selectors for
  these read models

Disposable client proof surfaces:

- the desktop proof panel composition
- proof-panel CSS and layout choices
- proof-only grouping of project workflow, task workflow, review, command, and
  SCM handoff panels
- guard tests that protect the current proof surface from accidentally growing
  mutation authority

Current product gaps:

- the UI is still a dense proof surface, not a durable panel/workspace design
- review decisions remain read-only; accepting or rejecting evidence is not in
  the product path yet
- SCM handoff stops at readiness; publication, branch/worktree, commit,
  snapshot, push, forge, and merge controls remain out of scope
- agent delegation scheduling is still not a normal user action from the
  selected-task flow
- planning and accepted-memory active apply remain deferred, so reviewed plans
  and memories do not yet become active server-local working state
- provider live-read expansion remains deferred; the current slice does not
  broaden provider families
- the current proof is local/desktop-heavy and does not yet prove multi-client
  remote authority or polished panel persistence
- god-file risk remains warning-only and should be managed in bounded health
  lanes rather than mixed into product decisions

## Deferred-Lane Comparison

Accepted memory active apply:

- status: continue-deferred
- reason: g04 proves memory/research context can be surfaced, but no visible
  workflow yet requires reviewed projected memories to become active
  server-local memory records
- return trigger: resume when the steward, planning, or selected-task context
  flow needs accepted memories as active working context

Planning import active apply:

- status: continue-deferred
- reason: g04 shows planning context and task seed surfaces, but the current
  proof does not need reviewed planning imports to mutate active project state
- return trigger: resume when project setup or planning conversation flow needs
  reviewed planning artifacts to become active project state with idempotency
  and repair

Provider live-read expansion:

- status: continue-deferred
- reason: the current product gap is workflow coherence and next-phase
  selection, not additional provider read families
- return trigger: resume when a concrete product workflow needs another read
  family and credential lease, network authority, payload retention, and
  sanitized evidence policy are explicit

Convergence backend execution:

- status: continue-deferred
- reason: SCM handoff readiness is now visible without requiring non-Git SCM
  execution, and Convergence is not yet a stable backend target
- return trigger: resume when Convergence exposes a stable backend execution
  surface and Nucleus needs it in a concrete user workflow

Panel/UI foundation:

- status: candidate-next-phase
- reason: the disposable proof has served its purpose and is now dense enough
  that usability, panel boundaries, and local UI state could become the next
  practical bottleneck
- constraint: do not treat this as final UI design or full workspace-system
  implementation without an explicit scope and throwaway-proof migration plan

Review decision controls:

- status: candidate-next-phase
- reason: the workflow now reaches review state and next-step presentation, but
  the user still cannot make explicit review decisions inside the product path
- constraint: keep review decisions separate from automatic task completion,
  provider execution, SCM mutation, and memory/planning apply

Agent delegation scheduling:

- status: candidate-next-phase
- reason: selected-task readiness and operator gate can describe delegation
  readiness, but the user cannot yet initiate a bounded agent work unit from
  the product flow
- constraint: must preserve task-backed work-unit, provider runtime, receipt,
  checkpoint, review, and cancellation/recovery boundaries

## Next Phase Decision

Decision:

- continue in g04
- open `012-selected-task-review-decision-controls.md`
- defer generation rollover until this lane closes or a larger architecture
  reset becomes necessary

Reason:

- g04 now reaches review state and pathway-backed next-step presentation
- review decisions are the smallest product-significant mutation still missing
  from the selected-task workflow
- the work is server-state work, not final UI work
- explicit review decisions unlock clearer task next-step, rework, and SCM
  handoff behavior without starting provider or SCM execution
- panel/UI foundation remains important, but the disposable proof can carry one
  more server-owned lane before a UI reset
- agent delegation scheduling remains important, but it widens provider/runtime
  scope more than explicit review decisions do

Non-goals:

- no automatic task completion from review acceptance
- no provider execution or agent scheduling
- no SCM, forge, publication, branch, worktree, commit, push, merge, snapshot,
  or publication mutation
- no accepted-memory or planning active apply
- no final UI or workspace panel implementation
- no client-side review authority

Next roadmap:

- `012-selected-task-review-decision-controls.md`

## Validation

Validation passed:

- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
- `effigy doctor`

Doctor remains warning-only for existing god-file scan findings.

## Boundary

This lane may:

- summarize implemented product workflow surfaces
- identify gaps in usability, authority, evidence, runtime, state, UI, and
  deferred-lane readiness
- recommend the next bounded lane or generation rollover
- compile roadmaps and batch cards for the selected next phase

This lane must not:

- implement new server behavior
- add mutation commands
- widen provider, SCM, memory, planning, or UI authority
- start final UI or panel-layout implementation
- use deferred lanes as automatic permission to resume subsystem work

## Stop Conditions

Stop and replan if closeout requires:

- a new contract or architecture decision before choosing the next phase
- operator intent between multiple similarly valid product directions
- provider execution or SCM/forge mutation
- active memory or planning apply
- final UI design commitments
