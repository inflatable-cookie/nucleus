# 012 Selected Task Review Decision Controls

Status: completed
Owner: Tom
Updated: 2026-07-07

## Purpose

Add explicit operator review decisions to the selected-task workflow without
making clients authoritative or turning review acceptance into automatic task
completion.

The g04 slice can now show selected-task review state, next-step context, and
SCM handoff readiness. The next product gap is that the user can inspect the
review but cannot record a decision through the server-owned workflow. This
lane adds the smallest useful mutation: a reviewed, idempotent decision record
that refreshes read models and leaves downstream task completion, rework,
agent delegation, and SCM handoff as separate commands.

## Governing Refs

- `docs/roadmaps/g04/001-product-workflow-rebaseline-and-vertical-slice.md`
- `docs/roadmaps/g04/009-selected-task-review-next-step-presentation.md`
- `docs/roadmaps/g04/010-selected-task-scm-handoff-readiness.md`
- `docs/roadmaps/g04/011-product-workflow-closeout-and-next-phase-selection.md`
- `docs/contracts/005-task-contract.md`
- `docs/contracts/007-server-boundary-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/contracts/023-task-backed-agent-workflow-contract.md`
- `docs/contracts/025-goal-loop-next-task-contract.md`

## Goals

- [x] Define the review-decision authority boundary, source refs, command
  shape, outcome vocabulary, and no-effect rules.
- [x] Add admission/readiness logic for explicit operator review decisions.
- [x] Persist review-decision records and expose them through existing
  selected-task review, timeline, next-step, and SCM handoff surfaces.
- [x] Add CLI, Effigy, and control DTO access for dry-run and apply paths.
- [x] Add disposable desktop proof controls that call the server boundary.
- [x] Validate the lane and decide the next product phase.

## Execution Plan

- [x] Batch 1: boundary, outcome vocabulary, source map, and stop conditions.
- [x] Batch 2: server admission/readiness and pure decision command planning.
- [x] Batch 3: persisted decision records, timeline refs, and read-model
  refresh.
- [x] Batch 4: control DTOs, `nucleusd`, and Effigy inspection/apply surfaces.
- [x] Batch 5: disposable desktop proof controls and stale-client handling.
- [x] Batch 6: lane validation, closeout, and next-phase selection.

## Batch Cards

Ready cards:

- None.

Planned cards:

- None.

Completed cards:

- `batch-cards/054-selected-task-review-decision-boundary.md`
- `batch-cards/055-selected-task-review-decision-admission.md`
- `batch-cards/056-selected-task-review-decision-records.md`
- `batch-cards/057-selected-task-review-decision-cli-effigy.md`
- `batch-cards/058-selected-task-review-decision-desktop-proof.md`
- `batch-cards/059-selected-task-review-decision-outcome-validation.md`

## Boundary

This lane may:

- inspect selected-task review evidence, task revision, runtime receipt refs,
  timeline refs, and SCM handoff readiness
- admit or refuse explicit operator review decisions
- record decision intent, source refs, expected revision, reviewed evidence
  refs, operator ref, reason text, and receipt refs
- represent outcomes such as accepted, rejected, needs changes, abandoned,
  blocked, stale, and duplicate
- refresh selected-task review, selected-task next-step, timeline, and SCM
  handoff evidence after a decision
- expose read-only and command surfaces through server-owned DTOs, CLI, Effigy,
  and disposable desktop controls

This lane must not:

- complete, archive, start, pause, or block tasks automatically
- start provider execution or schedule agents
- create branches, worktrees, commits, snapshots, pushes, PRs, publications, or
  merges
- apply accepted-memory or planning imports
- infer review acceptance from provider, SCM, CLI, or client state
- store raw provider payloads, raw command output, terminal streams, secrets,
  or private notes
- allow desktop code to mutate review state directly
- harden the disposable proof into final UI

## Review Decision Actions

The first decision set is intentionally small:

- accept evidence
- reject evidence
- request changes
- abandon review

Each decision requires:

- project id
- selected task id
- expected task or review revision when available
- operator ref
- reviewed evidence refs
- command/admission idempotency key
- reason text when rejecting, requesting changes, abandoning, or blocking

Decision records should be append-only from the read-model perspective. Later
commands may supersede a decision, but clients should not rewrite history.

## Authority Boundary

The server owns review-decision authority. Clients may request or preview a
decision, but they must not decide state locally or write decision records
directly.

The first command boundary is:

- pure admission over an existing selected-task review/next read model
- explicit operator intent
- sanitized source refs only
- idempotency before persistence
- append-only decision records in the next batch

The server must preserve these separations:

- accepting review evidence is not task completion
- rejecting or requesting changes is not agent scheduling
- abandoning review is not task archival
- review-decision readiness is not SCM/forge readiness
- CLI, Effigy, and desktop controls use the same server boundary

## Source Evidence

Admission may use these existing sources:

- selected task id and project id
- selected-task review state
- review work-item refs
- selected-task review evidence refs
- runtime receipt refs
- checkpoint refs
- diff summary refs
- validation refs
- timeline refs
- task-level review refs
- SCM handoff refs only as downstream context, not as authority to mutate SCM

Reviewed evidence refs must be drawn from selected-task review evidence. Raw
provider payloads, raw command output, terminal streams, and client-only refs
are invalid.

## Admission Shape

The pure admission input is:

- selected-task review/next read model
- action
- operator ref
- expected task or review revision
- current task or review revision when available
- reviewed evidence refs
- idempotency key
- optional reason
- existing decision ids for duplicate detection

The pure admission output is:

- admission id
- proposed decision id
- project id
- task id
- action
- status
- optional command
- optional refusal diagnostic
- operator ref
- sanitized evidence refs
- no-effect flags

## Persistence Shape

The selected-task review-decision record is sanitized and append-only from the
read-model perspective.

Stored fields:

- decision id
- admission id
- project id
- task id
- reviewed work-item refs
- action
- outcome
- operator ref
- expected revision
- reviewed evidence refs
- receipt refs
- timeline refs
- reason summary
- idempotency key
- persistence status
- blockers
- duplicate marker
- explicit no-effect flags

Persisted records live in the server artifact-metadata state domain under the
`selected-task-review-decision:` prefix. Duplicate and blocked admissions
return records for diagnostics but do not write local-store records.

Existing selected-task read models now consume persisted decision records:

- task workflow work-progress review status can refresh from persisted
  accepted/rejected/needs-changes/abandoned outcomes
- task workflow review refs include persisted decision ids
- accepted decision records add selected-task review-decision timeline refs
- selected-task review/next-step presentation sees refreshed review status and
  review refs through task workflow drilldown
- selected-task SCM handoff readiness sees decision ids as review evidence
  through task workflow drilldown

This does not create task lifecycle, provider, SCM/forge, memory, planning,
projection, scheduling, or UI effects.

## Admission Rules

Admission statuses:

- `admitted`
- `blocked`
- `stale`
- `duplicate`
- `unsupported`
- `missing_evidence`
- `no_op`

Refusal diagnostics:

- missing operator ref
- missing idempotency key
- missing expected revision
- stale expected revision
- duplicate decision id
- missing reviewed evidence refs
- unknown reviewed evidence refs
- missing reason
- review not awaiting that decision
- decision already represented

Compatibility rules:

- accept, reject, and request changes require `awaiting_review`
- abandon review is allowed from `awaiting_review`, `needs_changes`, or
  `rejected`
- accept on `accepted`, reject on `rejected`, request changes on
  `needs_changes`, and abandon on `abandoned` are no-ops
- reject, request changes, and abandon require a reason
- admission is pure and creates no review, task, provider, SCM, memory,
  planning, projection, scheduling, or UI effects

## Acceptance Criteria

- [ ] Review decisions are explicit server-owned commands.
- [ ] Admission refuses stale, duplicate, unsupported, or missing-evidence
  decisions with stable diagnostics.
- [x] Accepted/rejected/needs-changes/abandoned outcomes are persisted as
  sanitized refs and visible in selected-task review/next-step surfaces.
- [x] SCM handoff readiness can explain how a review decision affects handoff
  readiness without mutating SCM.
- [ ] CLI, Effigy, and disposable desktop proof paths use the same server
  boundary.
- [ ] Validation proves no provider, SCM, memory, planning, or final UI effects
  were added.

## Stop Conditions

Stop and replan if implementation requires:

- automatic task completion or task lifecycle transitions beyond explicit
  review-decision recording
- provider execution, agent scheduling, or live harness control
- SCM/forge mutation
- memory or planning active apply
- final workspace panel/UI commitments
- new client authority over review state
