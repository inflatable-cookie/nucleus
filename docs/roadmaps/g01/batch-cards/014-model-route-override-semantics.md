# 014 Model Route Override Semantics

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Draft project and session model-route override semantics.

## Scope

- Define how model routes may be overridden at project and session scope.
- Keep model route identity separate from adapter instance identity.
- Define what route metadata can be inherited from adapter defaults.
- Define when route overrides affect selection versus only runtime config.
- Keep provider implementation and model-router execution out of scope.

## Out Of Scope

- Model router implementation.
- Provider pricing or quota logic.
- UI picker behavior.
- Secret resolution.
- Provider adapter implementation.

## Evidence Questions

- Which route fields may be overridden per project?
- Which route fields may be overridden per session?
- How should task-level model preferences enter selection?
- What route override evidence should be persisted?
- How do OpenCode provider/model routes differ from direct API routes?

## Stop Conditions

- Model route id replaces adapter instance id.
- Session overrides mutate project or instance defaults.
- Provider route metadata hides harness adapter capabilities.
- Cost, quota, or policy decisions are invented without evidence.

## Promotion Targets

- `docs/contracts/004-model-routing-contract.md`
- `docs/contracts/009-adapter-registry-contract.md`
- `crates/nucleus-agent-protocol/src/`

## Validation

```sh
effigy qa:docs
effigy qa:northstar
cargo check --workspace
cargo test --workspace
```

## Next Task

Draft SCM/forge conflict and review workflow policy.
