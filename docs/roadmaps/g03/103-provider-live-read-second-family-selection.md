# 103 Provider Live Read Second Family Selection

Status: completed
Owner: Tom
Updated: 2026-06-23

## Purpose

Select the next read-only provider family after repository metadata smoke
evidence.

Candidate families include status/check, issue, comment, review workflow, and
provider credential repair evidence. Selection must be evidence-led and should
prefer the family that advances task completion/review workflows without
granting writes.

## Governing Refs

- `docs/contracts/027-provider-auth-forge-execution-contract.md`
- `docs/research/source-hubs/harness-communications.md`
- `docs/roadmaps/g03/102-provider-live-read-smoke-evidence-readiness-integration.md`

## Goals

- [x] Compare next-family candidates against task workflow value.
- [x] Identify provider API/CLI shape and required sanitized fields.
- [x] Write the approval gate for the next live-read smoke.
- [x] Stop before executing any provider command.

## Execution Plan

- [x] Audit candidate families and existing stopped refresh models.
- [x] Select one target family and provider target.
- [x] Draft smoke target, authority checklist, and blocked execution request
  cards.
- [x] Pause at operator approval.

## Batch Cards

Completed cards:

- `batch-cards/409-provider-live-read-second-family-candidate-audit.md`
- `batch-cards/410-provider-live-read-second-family-selection.md`
- `batch-cards/411-provider-live-read-second-family-approval-gate.md`
- `batch-cards/412-provider-live-read-second-family-validation.md`

## Acceptance Criteria

- [x] Next family is selected with explicit reasoning.
- [x] Required command/API fields are sanitized and bounded.
- [x] Operator approval gate exists before live execution.

## Selection

Selected family: status/check refresh.

Evidence and rationale are recorded in
`../../logs/2026-06-23-provider-live-read-second-family-selection.md`.

## Current Slice

Completed:

- inspected local `gh` help for status/check, PR, issue, and review surfaces
  without provider network calls.
- selected `gh pr checks` selected-field status/check refresh as the next
  family.
- wrote the approval gate and blocked effects.
