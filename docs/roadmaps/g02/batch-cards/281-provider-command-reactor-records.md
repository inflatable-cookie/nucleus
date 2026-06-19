# 281 Provider Command Reactor Records

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../063-provider-command-reactor-gate.md`

## Purpose

Define server-owned provider command reactor records before live provider send.

## Scope

- Add reactor admission records.
- Add queued command records.
- Add dispatch-attempt records.
- Add outcome records that can feed existing provider runtime receipts/events.
- Keep task mutation and provider send disabled.

## Acceptance Criteria

- Provider command reactor records are provider-neutral.
- Records distinguish admission, queueing, dispatch attempt, and outcome.
- Records can name command families without pretending every provider supports
  the same commands.
- Task mutation remains blocked.

## Validation

- [x] targeted server tests
- [x] `cargo check --workspace`
- [x] `git diff --check`

## Stop Conditions

- Stop if reactor records require changing the harness adapter contract first.

## Result

Added provider-neutral command reactor records for admission, queueing,
dispatch attempts, and outcomes.

The reactor accepts supported commands only for dry-run dispatch in this gate.
Live provider send and task mutation stay blocked, and reactor outcomes can be
converted into the existing provider runtime outcome surface for receipt/event
linkage.
