# 227 Codex Smoke Consolidation

Status: completed
Owner: Tom
Updated: 2026-07-20
Milestone: `../050-swallowtail-task-execution-adoption.md`
Auto-start next card: no

## Objective

Route the separately confirmed daemon smoke through Swallowtail or retire it
when shared-runtime evidence fully supersedes it.

## Acceptance

- [x] durable smoke evidence requirements are compared with Swallowtail output
- [x] one canonical live read-only transport remains
- [x] explicit operator confirmation remains required for the smoke
- [x] diagnostics preserve safe provider refs and cleanup evidence
- [x] superseded RPC code and tests are removed together

## Stop Condition

Stop if consolidation would turn a diagnostic smoke into product execution
authority.
