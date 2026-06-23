# 449 Task Project Next Lane Checkpoint

Status: completed
Owner: Tom
Updated: 2026-06-23
Milestone: `../110-task-project-workflow-depth.md`

## Purpose

Choose the next task/project lane after the first read-model slice.

## Candidate Lanes

- task mutation command boundary
- next-task readiness policy and scoring contract
- structured planning artifact to task seed promotion
- task work-item review and acceptance loop hardening
- project authority repair flow inspection

## Acceptance Criteria

- [x] Choice is based on implementation evidence.
- [x] Provider execution and UI design work remain out of scope unless selected
  explicitly.
- [x] Next roadmap has ready cards or an explicit planning gap.

## Decision

Next lane: structured planning artifact to task seed promotion.

Reason:

- the readiness projection now exposes task candidates, but Nucleus still lacks
  the planned path from project planning output into reviewable task seeds
- `crates/nucleus-server/src/task_seed.rs` is only a local bootstrap helper
- `docs/contracts/014-structured-project-planning-contract.md` defines planning
  sessions, planning artifacts, and task seed rules
- this lane improves the product workflow without provider execution, UI
  design, SCM/forge mutation, scoring policy, or autonomous goal loops

Deferred:

- task priority/scoring contract
- autonomous goal loops
- task mutation UI
- provider execution
- project authority repair flows
