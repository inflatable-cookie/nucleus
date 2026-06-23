# Task Seed Promotion Admission

Status: draft  
Owner: Tom  
Updated: 2026-06-23

## Purpose

Define the first admission rules for turning one reviewed planning task seed
into one active task-domain record.

Promotion is not task execution. It is a controlled task-authoring path from
accepted planning output into the Tasks domain.

## Governing Refs

- `docs/contracts/005-task-contract.md`
- `docs/contracts/014-structured-project-planning-contract.md`
- `docs/contracts/025-goal-loop-next-task-contract.md`
- `docs/architecture/planning-task-seed-gap-matrix.md`
- `docs/architecture/planning-task-seed-storage-codec-selection.md`

## Existing Command Anchor

Task creation already has a task-domain command path:

- `EngineTaskCommand::Create`
- `EngineTaskCommandService::create_task`
- task storage in the `Tasks` persistence domain
- `EngineRevisionExpectation::MustNotExist`

Task seed promotion must use that task-domain create path or a thin
task-domain wrapper around it. It must not write task records directly from a
planning query, seed helper, CLI shortcut, desktop action, or projection import.

## Allowed Admission State

A seed may be promoted only when all conditions are true:

- the seed belongs to the requested project
- `review` is `Accepted`
- `promotion` is `ReadyForPromotion`
- `blocking_questions` is empty
- title passes task title validation
- agent-readiness hints pass task create validation
- the destination task id does not already exist
- the planning seed record can be updated to `Promoted`

This deliberately requires both accepted review and explicit promotion
readiness. An accepted draft is not enough.

## Blocked Admission State

These states must not create a task:

- `review = Draft`
- `review = ReviewRequested`
- `review = ChangesRequested`
- `review = Rejected`
- `review = Superseded`
- `promotion = NotReady`
- `promotion = Reviewable`
- `promotion = Blocked`
- any non-empty `blocking_questions`

`promotion = Promoted` is also blocked from creating a new task. It is handled
as an idempotency or repair case, not as fresh creation.

## Field Mapping

Promotion maps seed fields into task create fields:

- `project_id` -> task `project_id`
- `title` -> task `title`
- `problem_statement` -> task `description`
- `acceptance_criteria_draft` -> task `acceptance_criteria`
- `suggested_importance` -> task `importance`
- `suggested_action_type` -> task `action_type`
- `agent_readiness_hints.suggested_readiness` -> task `agent_readiness`

Initial task activity should be `Proposed` unless a later policy explicitly
allows promotion into `Ready`.

Promotion must not assign the task to an agent, schedule work, select a
provider, run validation, start a goal loop, or mutate SCM/forge state.

## Idempotency Rule

Promotion needs stable source identity:

- seed id
- project id
- command id or promotion id
- resulting task ref

If a seed is already `Promoted { task_ref }` and that task exists, promotion is
a no-op outcome reporting `AlreadyPromoted`.

If a seed is already promoted but the referenced task is missing, promotion must
return a repair-required outcome. It must not create a replacement task under a
new id.

If the destination task id exists before the seed is marked promoted, promotion
must return a controlled conflict unless the existing task is exactly the task
record already referenced by the seed.

## Command Boundary

The next implementation card should add a bounded model with:

- promotion command id
- project id
- seed id
- expected seed revision
- optional explicit destination task id or deterministic task id rule
- outcome variants for promoted, already promoted, blocked, conflict, and
  repair required

The command should create at most one task and update at most one planning seed
record. Multi-seed promotion, projection export, management repo sync, task
ranking, and UI mutation remain out of scope.
