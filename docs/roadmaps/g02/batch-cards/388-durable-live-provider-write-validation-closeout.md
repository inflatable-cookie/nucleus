# 388 Durable Live Provider Write Validation Closeout

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../084-durable-codex-live-provider-write-invocation.md`

## Purpose

Validate durable live provider-write smoke invocation and choose the next lane.

## Scope

- Run focused and workspace validation.
- Update gap indexes from actual evidence.
- Decide whether to widen provider execution, return to SCM execution, or
  switch to remote host/client transport.

## Acceptance Criteria

- [x] Validation passes or blockers are recorded.
- [x] Gap indexes reflect the invocation evidence.
- [x] Next lane is selected from evidence.
- [x] Broad automation remains gated.

## Result

Validation passed. The next lane should use the durable live provider-write gate
and evidence capture path for a single explicitly confirmed Codex smoke before
any broader provider automation is widened.

## Validation

- `cargo check --workspace`
- `cargo test --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
