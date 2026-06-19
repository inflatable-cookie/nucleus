# 062 Provider Runtime Materialisation Gate

Status: completed
Owner: Tom
Updated: 2026-06-19

## Purpose

Turn the Codex runtime boundary proofs into a more service-shaped provider
runtime surface before task-state mutation widens.

Roadmap `061` proved recovery need, admission, envelope, receipt, and
diagnostics state. The next risk is not another provider record gate by itself;
it is that the records stay disconnected from the control API, provider
instance ownership, and the future provider-service command/event loop.

## Governing Refs

- `docs/contracts/002-harness-adapter-contract.md`
- `docs/contracts/010-agent-session-lifecycle-contract.md`
- `docs/contracts/018-orchestration-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/contracts/023-task-backed-agent-workflow-contract.md`
- `docs/architecture/t3-code-comparison.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Route Codex provider diagnostics through the control API surface.
- [x] Define provider-service ownership records without starting providers.
- [x] Define provider instance registry/config records without credential
      material.
- [x] Link provider-service outcomes to the existing orchestration/runtime
      receipt vocabulary.
- [x] Select task-state mutation only after provider-runtime ownership is
      explicit enough to test.

## Non-Goals

- Do not start real provider processes.
- Do not mutate task state from runtime observations.
- Do not add UI panels.
- Do not implement remote provider hosts, auth, or relay.
- Do not store raw provider payloads or credentials.

## Execution Plan

- [x] Diagnostics routing batch: expose Codex turn-start, callback,
      interruption, recovery, spawn, subscription, and ingestion diagnostics
      through the control API/query DTO boundaries.
- [x] Provider-service batch: add records for service-owned provider command
      routing, session runtime stream ownership, and reactor readiness.
- [x] Provider instance registry batch: add config/capability/readiness records
      for provider instances without hot reload or credentials.
- [x] Orchestration linkage batch: map provider-service outcomes into
      existing runtime receipt and event/projection vocabulary without task
      mutation.
- [x] Closeout batch: validate and choose either task-state mutation or live
      provider command reactor as the next gate.

## Batch Cards

Ready cards:

- None.

Planned cards:

- None.

Completed cards:

- `batch-cards/276-codex-diagnostics-control-routing.md`
- `batch-cards/277-provider-service-ownership-records.md`
- `batch-cards/278-provider-instance-registry-records.md`
- `batch-cards/279-provider-runtime-orchestration-linkage.md`
- `batch-cards/280-provider-runtime-materialisation-closeout.md`

## Acceptance Criteria

- [x] Clients can query Codex provider diagnostics through the control API
      without command authority.
- [x] Provider-service ownership is explicit and does not hide provider
      capability differences.
- [x] Provider instance registry records separate driver kind from configured
      provider instance.
- [x] Provider-service outcomes can be represented as runtime receipts/events
      without task mutation.
- [x] Validation passes.

## Gate

Do not implement task-state mutation from runtime observations until provider
diagnostics routing, provider-service ownership, and provider instance registry
records are explicit and tested.

Closeout selected live provider command reactor dry-run work as the next gate.
Task-state mutation remains behind a later explicit gate.
