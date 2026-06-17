# 029 Harness Evidence Refresh

Status: completed
Owner: Tom
Updated: 2026-06-17
Milestone: `../009-harness-runtime-target-selection.md`

## Purpose

Refresh harness communication evidence before choosing the first real runtime
target.

Provider docs and CLIs change quickly. The target decision must use current
evidence, not only the earlier first-pass hub.

## Scope

- Refresh `docs/research/source-hubs/harness-communications.md`.
- Refresh or add specimen dossiers where evidence changed.
- Check current evidence for Codex, Claude Code, Cursor CLI, Cursor SDK,
  OpenCode, Kimi Code, Kimi Agent SDK, Pi, GLM/Z.ai, MiniMax, DeepSeek,
  OpenRouter, and OpenCode Zen.
- Keep model/provider routing surfaces separate from full harness adapters.
- Compare evidence against T3 Code provider integration notes where useful.
- Record source dates or retrieval dates where current external docs are used.

## Acceptance Criteria

- Harness source hub reflects current evidence for the named candidates.
- Provider-routing-only surfaces remain separate from harness adapter
  candidates.
- Dossiers identify transport, identity, lifecycle, cancellation, permissions,
  resume, and terminal fallback evidence where available.
- Unverified or missing evidence is explicit.

## Validation

- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if current evidence contradicts an existing promoted contract.
- Stop if a candidate requires fresh operator intent before it can be
  classified as harness, model route, or both.

## Outcome

Refreshed `docs/research/source-hubs/harness-communications.md` and
`docs/research/source-hubs/provider-routing-and-model-surfaces.md`.

The refresh confirmed the existing split: Codex, Claude, Cursor CLI, OpenCode,
Kimi, Pi, and Nucleus-native steward remain harness/runtime candidates; GLM,
MiniMax, DeepSeek, OpenRouter, and OpenCode Zen remain model/provider-routing
surfaces unless paired with a harness.
