# 429 Live Evidence Task State Control Vocabulary

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../093-live-evidence-task-state-control-integration.md`

## Purpose

Define server control vocabulary for explicit live evidence task-state
transition admission.

## Scope

- Name the command/query shape without executing provider or SCM effects.
- Keep vocabulary distinct from generic task mutation.
- Preserve unsupported-state behavior.

## Acceptance Criteria

- [x] Control vocabulary names live evidence task-state transition admission.
- [x] Vocabulary requires task/work/completion/operator/evidence refs.
- [x] Unsupported control labels remain explicit.
- [x] No provider/SCM authority is added.

## Validation

- `cargo test -p nucleus-server live_evidence_task_state_control_vocabulary -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
