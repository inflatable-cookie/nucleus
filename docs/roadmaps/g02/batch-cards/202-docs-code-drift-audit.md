# 202 Docs Code Drift Audit

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../044-scm-workflow-closeout-and-next-phase-selection.md`

## Purpose

Compare roadmap and contract claims to current code.

## Scope

- Inspect relevant Rust modules and docs claims.
- Correct overclaims or stale missing-state notes.
- Do not implement new behavior.

## Acceptance Criteria

- Docs accurately separate implemented, planned, and missing behavior.
- Drift findings are promoted to gap indexes or roadmap closeout.

## Validation

- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if drift reveals a safety issue that should block phase selection.

## Result

Docs were corrected to separate metadata/type surfaces from provider-executing
SCM runtime. The current doctor report is now reflected in the audit docs.
