# 019 Native Steward Command Boundary

Status: active
Owner: Tom
Updated: 2026-06-18

## Purpose

Turn the native steward record surfaces into policy-gated command preparation
and admission paths, without starting autonomous live execution.

This milestone follows `018-steward-native-harness-and-effigy-tools.md`.

## Governing Refs

- `docs/contracts/012-native-harness-runtime-contract.md`
- `docs/contracts/016-effigy-project-integration-contract.md`
- `docs/contracts/018-orchestration-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/contracts/011-scm-forge-sync-contract.md`

## Goals

- [x] Define native steward command requests and command outcomes.
- [x] Add read-only and proposal-only admission checks.
- [x] Link steward tool commands to runtime receipts and audit refs.
- [ ] Keep mutation, commit, push, publication, and forge calls out of scope.

## Execution Plan

- [x] Command model batch: add native steward command request and outcome
  records.
- [x] Admission batch: enforce read-only, proposal-only, and approval-required
  authority gates.
- [x] Receipt batch: link accepted steward commands to runtime receipt refs and
  sanitized evidence.
- [ ] Server boundary batch: prepare request-handler surfaces without live
  steward execution.
- [ ] Validation batch: prove no command path mutates project, SCM, or forge
  state.

## Batch Cards

Ready cards:

- `batch-cards/077-server-steward-command-boundary.md`

Planned cards:

- `batch-cards/078-native-steward-command-validation.md`

Completed cards:

- `batch-cards/074-native-steward-command-records.md`
- `batch-cards/075-native-steward-command-admission.md`
- `batch-cards/076-native-steward-command-receipt-linkage.md`

## Acceptance Criteria

- [x] Steward commands are distinct from steward proposals.
- [x] Command admission can reject unsupported authority escalation.
- [x] Accepted commands can cite runtime receipts and sanitized evidence.
- [ ] No first-pass steward command commits, pushes, publishes, or calls a
  forge.

## Gate

Do not implement autonomous steward loops until command admission, receipt
linkage, review state, and recovery behavior are proven.
