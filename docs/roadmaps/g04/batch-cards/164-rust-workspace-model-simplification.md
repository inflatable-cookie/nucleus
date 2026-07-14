# 164 Rust Workspace Model Simplification

Status: completed
Owner: Codex
Updated: 2026-07-13
Milestone: `../031-window-region-panel-simplification.md`
Auto-start next card: yes

## Objective

Remove hosted-Surface identity from `nucleus-workspaces` and resolve panel
placement directly against windows.

## Governing Refs

- `../../../architecture/product-workflow-ui-architecture.md`
- `../../../contracts/006-workspace-layout-contract.md`

## Scope

1. Remove Surface ids, records, lifecycle helpers, and exports.
2. Make project placements target a Window id and Region id.
3. Simplify global shell records and generic panel tab identity.
4. Update focused tests and public exports.

## Acceptance Criteria

- crate API contains no hosted-Surface model
- window-aware panel resolution is deterministic
- local layout remains local-client-profile scoped
- downstream workspace command types compile

## Validation

- focused `nucleus-workspaces` tests
- `cargo check --workspace`

## Evidence

- focused test output
- workspace compile output

## Stop Conditions

- another crate constructs or semantically depends on Surface records

## Next

Auto-start card 165.

## Outcome

- Hosted-Surface modules, ids, lifecycle helpers, and exports are removed.
- Project panels resolve directly against Window ids and Region ids.
- Global shell state now contains display inventory and windows only.
