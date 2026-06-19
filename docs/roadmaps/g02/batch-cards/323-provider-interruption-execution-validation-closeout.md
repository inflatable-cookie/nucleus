# 323 Provider Interruption Execution Validation Closeout

Status: planned
Owner: Tom
Updated: 2026-06-19
Milestone: `../071-codex-provider-interruption-execution-gate.md`

## Purpose

Validate the provider interruption execution gate and select the next runtime
target.

## Scope

- Run the lane validation suite.
- Update gap indexes and roadmap state.
- Decide whether the next lane is recovery execution, checkpoint/diff linkage,
  loop orchestration, provider session persistence, or UI proof.

## Acceptance Criteria

- [ ] Validation passes or blockers are recorded.
- [ ] Roadmap state has one clear next task.
- [ ] No raw provider material is persisted or exposed.

## Validation

- `cargo check --workspace`
- `cargo test --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
