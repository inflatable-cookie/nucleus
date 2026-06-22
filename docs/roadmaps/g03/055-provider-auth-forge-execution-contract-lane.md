# 055 Provider Auth Forge Execution Contract Lane

Status: completed
Owner: Tom
Updated: 2026-06-21

## Purpose

Compile the provider-auth and forge execution contract lane before any real
forge network writes, callbacks, recovery, task mutation, or raw-output
authority.

This lane turns the Git/forge runner health rebaseline into a focused authority
contract for credential refs, network-write admission, provider response
evidence, idempotency, retry/recovery, and operator review.

## Governing Refs

- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/contracts/017-engine-host-authority-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/contracts/027-provider-auth-forge-execution-contract.md`
- `docs/roadmaps/g03/054-git-forge-runner-health-boundary-rebaseline.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Add a focused provider-auth and forge execution authority contract.
- [x] Keep credential material outside SCM/forge adapters and durable docs.
- [x] Separate credential authority, network authority, forge authority, and
  operator approval.
- [x] Define idempotency, retry, recovery, receipt, and provider-response
  evidence requirements.
- [x] Select a stopped implementation lane before any real provider writes.

## Execution Plan

- [x] Contract surface and index wiring.
- [x] Admission and preflight boundary definition.
- [x] Evidence, idempotency, retry, and recovery rules.
- [x] Roadmap and batch-card closeout.
- [x] Validation closeout.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/188-provider-auth-contract-surface.md`
- `batch-cards/189-forge-network-admission-boundary.md`
- `batch-cards/190-provider-evidence-idempotency-recovery-rules.md`
- `batch-cards/191-provider-auth-contract-index-closeout.md`
- `batch-cards/192-next-stopped-provider-admission-selection.md`
- `batch-cards/193-provider-auth-contract-validation-closeout.md`

## Acceptance Criteria

- [x] A focused contract owns provider-auth and forge network execution
  authority.
- [x] Credential refs are separated from credential material.
- [x] Network-backed forge writes require network authority and operator
  approval.
- [x] Provider responses become sanitized evidence and receipts.
- [x] Retries and recovery remain server-owned and idempotency-backed.
- [x] The next implementation lane remains stopped by default.

## Closeout

`027-provider-auth-forge-execution-contract.md` now owns the provider-auth and
forge network execution boundary.

Key decisions:

- credential refs are safe domain records; credential material remains behind
  host credential authority
- network-backed forge execution needs separate network authority, credential
  authority, SCM/forge authority, and operator approval
- idempotency keys are mandatory for mutating provider effects
- uncertain writes reconcile before retry
- provider success creates observations, receipts, provider refs, review refs,
  and task-link proposals, not task mutation
- outbound provider execution and inbound webhook/callback handling are
  separate lanes
- first implementation after this lane should be stopped admission/preflight
  records only
