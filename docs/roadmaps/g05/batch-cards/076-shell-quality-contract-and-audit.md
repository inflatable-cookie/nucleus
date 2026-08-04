# 076 Shell Quality Contract And Audit

Status: completed
Owner: Tom
Created: 2026-08-04
Milestone: `../024-shell-accessibility-responsive-and-failure-cohesion.md`
Depends on: card 075
Auto-start next card: yes

## Objective

Promote one durable shell-quality boundary and inventory the concrete semantic,
responsive, and recovery gaps before implementation.

## Acceptance

- [x] Contract 006 defines semantic controls, keyboard parity, focus stability, and announcements
- [x] panel adaptation is explicitly container-relative
- [x] horizontal overflow and primary-action rules are explicit
- [x] failure ownership and exact retry boundaries are explicit
- [x] the first implementation batch is bounded to observed gaps

## Validation

- [x] contract, architecture, and current Svelte evidence agree

## Stop Conditions

- do not create a Nucleus focus manager or generic durable panel-state domain
- do not force one generic presentation onto specialist panel workflows

## Evidence

- Contract 006 and the product workflow UI architecture now own the boundary.
- Current Svelte evidence exposes one Nucleus-owned static-interaction warning.
- Workspace sidebar tabs already use container queries, while several movable
  panels still use viewport media queries and therefore adapt to the wrong box.
- loading and failure semantics exist but remain locally inconsistent; cards
  079-080 retain panel ownership instead of centralizing state.
