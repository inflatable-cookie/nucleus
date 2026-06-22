# 090 Provider Live Read Smoke Approval Gate

Status: completed
Owner: Tom
Updated: 2026-06-22

## Purpose

Prepare the first real provider read smoke without executing it.

This lane names the approval, provider, credential lease, network authority,
payload policy, retention policy, and evidence requirements for a future live
read. It remains stopped until the operator explicitly approves a concrete
provider/repo/operation smoke.

## Governing Refs

- `docs/contracts/027-provider-auth-forge-execution-contract.md`
- `docs/roadmaps/g03/089-provider-live-read-execution-contract-and-adapter-boundary.md`
- `docs/architecture/implementation-audit.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Select the first live-read provider and operation family.
- [x] Define credential lease and network-read authority evidence.
- [x] Define payload, sanitization, and retention policy requirements.
- [x] Add a stopped live-read smoke request record that cannot execute by default.
- [x] Leave actual provider network execution behind explicit operator
  approval.

## Execution Plan

- [x] Add live-read smoke target selection records.
- [x] Add credential lease and network authority checklist records.
- [x] Add stopped live-read smoke request records and blockers.
- [x] Add validation and approval checkpoint docs.

## Batch Cards

Completed cards:

- `batch-cards/361-provider-live-read-smoke-target-selection.md`
- `batch-cards/362-provider-live-read-smoke-authority-checklist.md`
- `batch-cards/363-provider-live-read-stopped-smoke-request.md`
- `batch-cards/364-provider-live-read-smoke-approval-validation.md`

Ready cards:

None.

## Acceptance Criteria

- [x] A concrete smoke candidate is named without executing provider I/O.
- [x] Required credential, network, payload, retention, and evidence refs are
  explicit.
- [x] Stopped smoke requests default to blocked until operator approval exists.
- [x] Next task does not imply live provider access.

## Current Slice

Closed:

- smoke target, authority checklist, and stopped smoke request records are
  represented without provider I/O, credential material, provider writes, task
  mutation, callback/interruption/recovery execution, or raw payload retention.

Next:

- pause at `g03/091` for explicit operator approval before any live provider
  read smoke.

## Stop Conditions

- Stop before real provider network calls.
- Stop before credential material resolution.
- Stop before provider writes, status/check writes, comments, review actions,
  labels, branch mutation, merges, or pull-request mutation.
- Stop before task mutation, callback execution, interruption execution, or
  recovery execution.
- Stop before raw provider payload retention.
