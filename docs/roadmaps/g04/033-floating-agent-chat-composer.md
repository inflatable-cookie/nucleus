# 033 Floating Agent Chat Composer

Status: completed
Owner: Tom
Updated: 2026-07-13

## Purpose

Turn Agent Chat's basic footer into a minimal floating composer with functional
model and reasoning selection.

## Governing Refs

- `../../specs/010-floating-agent-chat-composer.md`
- `../../architecture/product-workflow-ui-architecture.md`
- `../../contracts/006-workspace-layout-contract.md`
- `../../contracts/023-task-backed-agent-workflow-contract.md`

## Execution Plan

- [x] Promote compact composer and route-selection boundaries.
- [x] Expose provider catalog and per-turn model/reasoning overrides.
- [x] Build the floating composer in the existing Agent Chat panel.
- [x] Run desktop, Rust, interaction, and visual checks; stop for design review.

## Batch Cards

Completed:

- `batch-cards/173-floating-chat-composer-validation-checkpoint.md`
- `batch-cards/171-chat-provider-catalog-and-turn-overrides.md`
- `batch-cards/172-floating-chat-composer-visual-slice.md`
- `batch-cards/170-chat-route-selection-boundary.md`

## Outcome

The floating composer, real model/reasoning overrides, responsive controls, and
operator-directed visual tuning are accepted as the current baseline.
