# 003 Cursor CLI Adapter Readiness Research

Status: completed-first-pass
Owner: Tom
Updated: 2026-06-15

## Goal

Determine whether Cursor CLI is ready for an ACP-first nucleus adapter.

## Scope

- Inspect Cursor CLI ACP behavior and public docs.
- Compare with T3 Code Cursor integration.
- Record ACP initialize, session, permission, elicitation, resume, and event
  identity behavior.

## Out Of Scope

- Implementing Cursor support.
- Using Cursor SDK as the same adapter path.
- Building ACP client runtime.

## Evidence Questions

- What command and environment shape starts Cursor ACP?
- Which ACP messages carry stable ids?
- How does Cursor expose permission and elicitation requests?
- How does session resume work, if available?
- How are plan/default/approval modes represented?
- Which Cursor-specific extension events must be retained separately?

## Stop Conditions

- ACP events cannot be correlated to stable nucleus events.
- Permission or elicitation requests cannot be surfaced to the server.
- Cursor SDK and Cursor CLI semantics are mixed into one false adapter.

## Promotion Targets

- `docs/research/specimen-dossiers/cursor-cli-runtime-boundary.md`
- `docs/contracts/002-harness-adapter-contract.md`
- `docs/contracts/010-agent-session-lifecycle-contract.md`

## Validation

```sh
effigy qa:docs
effigy qa:northstar
```
