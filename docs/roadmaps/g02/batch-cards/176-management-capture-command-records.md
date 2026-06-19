# 176 Management Capture Command Records

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../039-scm-management-capture-and-share-foundation.md`

## Purpose

Add the first management capture request/admission record shapes without
executing SCM provider commands.

## Scope

- Add engine/domain records for management capture preparation.
- Represent target project, repo membership, projection root, requested file
  refs, capture reason, and policy gates.
- Keep records provider-neutral and append-only where possible.
- Do not create Git commits, Convergence snaps, publications, pushes, or review
  requests.

## Acceptance Criteria

- Capture preparation can be represented as a durable command/admission record.
- Records can distinguish local preparation from provider share/publish steps.
- Tests cover accepted and rejected admission cases.

## Validation

- Targeted Rust tests for management capture records.
- `cargo check --workspace`

## Stop Conditions

- Stop if the record model requires provider-specific SCM vocabulary to express
  the core operation.

## Result

Added provider-neutral management capture command and admission records in
`nucleus-engine`. Capture commands name project, repo membership, repository
ref, projection root, file refs, reason, policy gates, and evidence without
creating provider SCM mutations.
