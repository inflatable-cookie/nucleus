# 072 Native Model Backend Posture Records

Status: completed
Owner: Tom
Updated: 2026-06-18
Milestone: `../018-steward-native-harness-and-effigy-tools.md`

## Purpose

Keep native model backend choice explicit and authority-neutral.

## Scope

- Refine local, cloud, sidecar, and custom model backend records where needed.
- Represent backend suitability for deterministic tools, summarization,
  classification, and proposal drafting.
- Prove backend choice does not increase persona authority.
- Do not integrate an inference runtime.

## Acceptance Criteria

- [x] Backend records can represent local-only, cloud-only, either, and disabled
  deployment posture.
- [x] Steward authority remains controlled by persona policy, not backend kind.
- [x] Backend records can support later local/small-model experiments.

## Outcome

- Added backend deployment posture, suitability, and status records.
- Kept backend choice descriptive and authority-neutral.
- Left inference runtime selection out of scope.

## Validation

- [x] `cargo test -p nucleus-native-harness backend`
- [x] `cargo check --workspace`
- [x] `effigy qa:docs`
- [x] `effigy qa:northstar`
- [x] `rg -n '^## Next Task' README.md AGENTS.md docs`
- [x] `git diff --check`

## Stop Conditions

- Stop if this requires choosing Ollama, llama.cpp, Candle, mistral.rs, Pi, or
  any cloud provider as the first runtime.
