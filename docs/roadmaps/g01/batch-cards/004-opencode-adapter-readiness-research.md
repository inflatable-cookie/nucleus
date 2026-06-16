# 004 OpenCode Adapter Readiness Research

Status: completed-first-pass
Owner: Tom
Updated: 2026-06-15

## Goal

Determine whether OpenCode should start server-SDK-first, ACP-first, or both.

## Scope

- Inspect OpenCode server, SDK, CLI, and ACP surfaces.
- Compare with T3 Code OpenCode integration.
- Record session, event, model route, permissions, cancellation, and resume
  behavior.

## Out Of Scope

- Implementing OpenCode support.
- Building a model gateway.
- Treating OpenCode Zen as a harness adapter.

## Evidence Questions

- Which OpenCode surface has the strongest stable identity model?
- How does the local or external OpenCode server map sessions and events?
- What does ACP expose compared with the SDK/server path?
- How should OpenCode Zen be represented as model routing rather than harness
  control?
- What provider-specific config belongs in adapter registry records?

## Stop Conditions

- SDK/server events and ACP events cannot be reconciled into one adapter
  posture.
- Model gateway behavior is confused with harness session lifecycle.
- External server ownership is not explicit.

## Promotion Targets

- `docs/research/specimen-dossiers/opencode-runtime-boundary.md`
- `docs/contracts/002-harness-adapter-contract.md`
- `docs/contracts/004-model-routing-contract.md`
- `docs/contracts/009-adapter-registry-contract.md`

## Validation

```sh
effigy qa:docs
effigy qa:northstar
```

## Next Task

Research Nucleus native harness and steward runtime semantics.
