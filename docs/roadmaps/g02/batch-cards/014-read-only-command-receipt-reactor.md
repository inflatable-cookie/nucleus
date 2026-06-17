# 014 Read Only Command Receipt Reactor

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Connect the existing read-only command runner proof path to runtime receipts.

## Scope

- Map read-only command control results to runtime receipt records.
- Preserve existing command evidence behavior.
- Keep command execution admission unchanged.
- Record sanitized progress/status only.

## Out Of Scope

- Write-capable command execution.
- Provider harness effects.
- Scheduler redesign.
- Artifact payload download.

## Promotion Targets

- `crates/nucleus-server`
- `docs/contracts/020-runtime-receipt-contract.md`

## Acceptance Criteria

- [x] Read-only command execution produces a runtime receipt or explicit deferred
  receipt gap.
- [x] Existing command evidence tests still pass.
- [x] Receipt creation does not store raw stdout, stderr, shell traces, or
  environment values.

## Stop Conditions

- Receipt creation requires changing command execution safety policy.

## Outcome

Mapped read-only command control results to runtime receipt records after
sanitized command evidence is persisted.
