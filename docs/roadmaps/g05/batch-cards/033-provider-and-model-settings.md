# 033 Provider And Model Settings

Status: completed
Owner: Tom
Created: 2026-08-01
Milestone: `../011-provider-and-product-settings.md`
Depends on: card 032
Auto-start next card: yes

## Objective

Project configured providers, model discovery, defaults, reasoning, and
session mode into Settings without mutating prepared sessions.

## Acceptance

- [x] configured provider instances and sanitized readiness are visible
- [x] default model, reasoning, and harness mode are explicit typed settings
- [x] active sessions are replaced rather than silently mutated
- [x] provider capability gaps remain visible and non-fabricated

## Validation

- [x] focused projection, persistence, and session-replacement fixtures pass

## Stop Conditions

- do not duplicate Swallowtail provider or model vocabularies

## Evidence

- one typed Nucleus provider summary projects `codex:local-default`, the
  adapter identity, provider-managed auth posture, discovery status, and the
  portable model catalogue without provider-native payload parsing
- the shared preferences domain persists staged default model, reasoning, and
  normal/plan mode values; unavailable configured models remain explicit
- new route defaults flow only into conversations without stored or explicit
  route state; existing route-change handling still prepares a fresh session
- native Settings discovered seven models, projected Plan into an empty
  composer, then reset to the final Normal default without running a turn
