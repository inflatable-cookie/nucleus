# 285 Provider Read-Intent Consumption Options

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../076-provider-read-intent-product-consumption-decision.md`

## Purpose

Compare first product consumption options for provider read-intent.

## Options

- Visible desktop provider panel: rejected for now because it would make UI
  design decisions before the server projection is useful.
- More read-family fan-out: rejected for now because the reusable projection
  shape should be consumed before stamping out more families.
- Live provider reads: rejected for now because it would grant provider network
  authority.
- Provider Readiness Overview projection: selected because it is server-first,
  client-safe, and useful to CLI, desktop, web, and mobile clients.

## Acceptance Criteria

- [x] Options are explicit.
- [x] Rejected options have reasons.
- [x] The selected option is bounded.
