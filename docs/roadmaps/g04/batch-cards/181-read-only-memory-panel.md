# 181 Read-Only Memory Panel

Status: completed
Owner: Codex
Updated: 2026-07-14
Milestone: `../036-project-memory-panel.md`
Auto-start next card: yes

## Objective

Connect existing accepted-memory and memory-proposal queries to one compact,
project-scoped Memory panel.

## Governing Refs

- `../../../contracts/013-shared-memory-contract.md`
- `../../../architecture/product-workflow-ui-architecture.md`
- `../036-project-memory-panel.md`

## Scope

- add the missing accepted-memory TypeScript query/response adapter
- load accepted and proposed summaries together for the selected project
- render identity, lifecycle metadata, and bounded reference counts only
- show explicit loading, empty, unsupported, and error states
- no accept, reject, edit, archive, extraction, or projection controls

## Acceptance

- accepted and proposed records are visibly distinct
- records remain legible in narrow and wide panel regions
- the client does not invent missing titles or bodies
- project changes cannot display stale memory results

## Validation

- desktop type check and production build
- focused source guard for read-only panel composition

## Stop Conditions

- existing DTOs cannot supply a truthful useful summary
- implementation requires memory mutation or private payload exposure

## Outcome

The desktop client now adapts the existing accepted-memory query and composes
it with memory proposals in a project-scoped Memory panel. The single-column
inspector shows only sanitized identity, lifecycle metadata, actor refs, and
bounded counts. It has no mutation controls.
