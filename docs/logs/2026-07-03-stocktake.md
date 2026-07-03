# 2026-07-03 Stocktake

## Summary

Nucleus is still on course.

Recent work has been heavy, but not empty churn: it built controlled server
surfaces for task/project workflow, task seeds, task seed promotion,
management projection payloads, deterministic planning file export,
publication/share admission, and import/admission diagnostics.

The risk is now over-investing in projection mechanics before the app-native
planning domain exists.

## Current State

- `g03` remains the active generation.
- Provider execution, SCM/forge mutation, task mutation, raw payload retention,
  and UI expansion remain gated.
- `effigy doctor` reports zero errors and warning-only god-file findings.
- The old `108-server-client-workflow-hardening` wrapper lane is now closed by
  child roadmaps `109` through `117`.
- `117-planning-projection-import-admission` is closed.
- The next active lane is `118-structured-planning-domain-foundation`.

## Direction Check

The original goal is a project-oriented AI development environment with:

- durable project/task authority
- app-native planning and project backbone state
- managed agent/harness interaction
- committable project management projections
- controlled SCM/forge workflow
- eventual desktop/web/mobile control planes

The current implementation supports that direction, but the next work should
shift back from sync/projection mechanics into product-domain shape.

## Decision

Select structured planning domain foundation as the next lane.

Reason:

- import/admission is now represented as stopped and reviewable
- active import apply would need a real planning domain target
- memory and deep research should link to planning records, not float as
  independent mechanisms
- guided planning and open-ended exploration are central to the original
  Nucleus product idea

## Deferred

- active planning import apply
- memory extraction and embeddings
- deep research execution
- final planning UI
- autonomous planning loops
- provider execution expansion
- SCM/forge mutation expansion

## Next

Execute `docs/roadmaps/g03/batch-cards/505-structured-planning-domain-boundary-selection.md`.
