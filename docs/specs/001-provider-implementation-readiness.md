# 001 Provider Implementation Readiness

Status: draft
Owner: Tom
Updated: 2026-06-15

## Purpose

Define the evidence gates that must be satisfied before nucleus implements any
provider adapter.

Provider implementation is risky because every harness has different transport,
identity, approval, resume, cancellation, and process-control behavior. This
spec keeps the first implementation path evidence-led.

## Scope

In scope:

- adapter readiness criteria
- first provider research cards
- promotion targets for provider-specific findings
- stop conditions before implementation
- ordering for first adapter candidates

Out of scope:

- provider adapter implementation
- server runtime behavior
- storage backend selection
- auth and secret storage implementation
- UI design

## Readiness Criteria

A provider is implementation-ready only when its research card answers:

- supported transport path
- process/runtime ownership model
- session id model
- message/event id model
- turn and tool-call id model
- approval and permission model
- cancellation and interruption model
- resume and recovery model
- config/auth preflight model
- terminal rendering fallback rule
- adapter capability snapshot
- unresolved risks

If a field is unknown, the provider is not blocked automatically, but the
unknown must be explicit and reflected in adapter capabilities.

## First Provider Order

Initial research order:

1. Codex
2. Cursor CLI
3. OpenCode
4. Claude
5. Kimi
6. Pi

Reasoning:

- Codex is the current harness environment and a reference target for nucleus.
- Cursor CLI and OpenCode give ACP/server contrasts.
- Claude needs careful CLI-versus-SDK handling.
- Kimi and Pi already have first-pass dossiers and should be checked against
  the common readiness template.

## Stop Conditions

Do not implement a provider adapter if:

- the adapter identity model cannot preserve provider instance identity
- session or event identity would depend on display text or timestamps alone
- approval or permission behavior would be hidden from the server
- cancellation semantics are unknown and cannot be marked as unsupported
- resume/recovery behavior is assumed rather than evidenced
- implementation requires storing raw secrets in adapter registry records
- the provider path requires UI scraping without an explicit fallback contract

## Promotion Targets

Durable findings should promote into:

- `docs/contracts/002-harness-adapter-contract.md`
- `docs/contracts/009-adapter-registry-contract.md`
- `docs/contracts/010-agent-session-lifecycle-contract.md`
- `docs/architecture/system-architecture.md`
- provider-specific specimen dossiers under `docs/research/specimen-dossiers/`

## Acceptance Criteria

- First provider research cards exist.
- Each card has evidence questions, stop conditions, and promotion targets.
- The roadmap points at the first research card instead of implementation.
- No provider implementation starts until at least one card is complete and
  promoted into contracts.

## Next Task

Draft runtime effect trait boundary.
