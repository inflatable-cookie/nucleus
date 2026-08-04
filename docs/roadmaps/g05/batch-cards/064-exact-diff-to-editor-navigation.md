# 064 Exact Diff To Editor Navigation

Status: completed
Owner: Tom
Created: 2026-08-03
Milestone: `../021-editor-diff-review-rework-cohesion.md`
Depends on: card 063
Auto-start next card: yes

## Objective

Carry the reviewed source snapshot's exact resource identity and safe path into
the existing Editor panel.

## Acceptance

- [x] task-diff overview returns optional exact resource identity
- [x] baseline and target resource disagreement fails closed
- [x] Diff passes resource id, display path, and opaque file ref to Editor
- [x] missing or expired identity remains explicit and is never substituted

## Validation

- [x] focused Rust lineage and desktop navigation fixtures pass

## Stop Conditions

- do not turn snapshot storage paths into client data
- do not infer a resource from project ordering

## Evidence

The task-diff overview resolves resource identity only when both immutable
snapshot manifests agree. Diff now passes that id, the safe path, and the
opaque file ref to the existing Editor route. Four focused server tests and the
desktop panel guards pass.
