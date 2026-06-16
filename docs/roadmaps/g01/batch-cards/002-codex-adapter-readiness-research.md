# 002 Codex Adapter Readiness Research

Status: completed-first-pass
Owner: Tom
Updated: 2026-06-15

## Goal

Determine whether Codex is ready for a first nucleus adapter implementation.

## Scope

- Inspect official Codex CLI/app-server documentation and local behavior.
- Compare with T3 Code Codex integration.
- Record transport, identity, approval, resume, cancellation, and recovery
  evidence.
- Promote stable findings into adapter and lifecycle contracts.

## Out Of Scope

- Implementing a Codex adapter.
- Adding process management.
- Adding server runtime behavior.
- Selecting storage or auth backends.

## Evidence Questions

- Which Codex transport should nucleus use first?
- What ids exist for sessions, turns, messages, tool calls, approvals, and
  provider events?
- How does Codex expose approval and structured user-input requests?
- What cancellation, rollback, and resume controls exist?
- What data survives process/server restart?
- What config/auth preflight can be checked without starting work?
- Which capabilities are supported, partial, unsupported, or unknown?

## Stop Conditions

- Session identity cannot be preserved across server restart.
- Event identity would require display text or timestamps alone.
- Approval handling cannot be surfaced as server-owned state.
- The only viable route is brittle terminal scraping without a terminal
  fallback contract.

## Promotion Targets

- `docs/research/specimen-dossiers/codex-runtime-boundary.md`
- `docs/contracts/002-harness-adapter-contract.md`
- `docs/contracts/010-agent-session-lifecycle-contract.md`
- `docs/architecture/system-architecture.md`

## Validation

```sh
effigy qa:docs
effigy qa:northstar
```

## Next Task

Draft projection storage Rust surface boundaries.
