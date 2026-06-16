# 005 Claude Adapter Readiness Research

Status: completed-first-pass
Owner: Tom
Updated: 2026-06-15

## Goal

Determine whether Claude should start as CLI/PTY, SDK sidecar, or another
supported route.

## Scope

- Inspect Claude Code CLI behavior and official references.
- Compare with T3 Code Claude SDK integration.
- Record permission, resume, interruption, message stream, and terminal
  rendering behavior.

## Out Of Scope

- Implementing Claude support.
- Choosing a permanent auth mechanism.
- Hiding CLI limitations behind a false structured interface.

## Evidence Questions

- What does Claude Code CLI expose that Rust can control directly?
- What does the Claude Agent SDK expose that CLI control does not?
- Which path preserves session, message, turn, and approval identity best?
- What limitations require terminal rendering fallback?
- How do permissions and interruptions behave across resume?

## Stop Conditions

- SDK and CLI paths cannot be compared with enough evidence.
- Provider restrictions make direct automation unsupported.
- Permission handling cannot be represented in server state.

## Promotion Targets

- `docs/research/specimen-dossiers/claude-runtime-boundary.md`
- `docs/contracts/002-harness-adapter-contract.md`
- `docs/contracts/009-adapter-registry-contract.md`
- `docs/contracts/010-agent-session-lifecycle-contract.md`

## Validation

```sh
effigy qa:docs
effigy qa:northstar
```

## Next Task

Draft SCM/forge conflict and review workflow policy.
