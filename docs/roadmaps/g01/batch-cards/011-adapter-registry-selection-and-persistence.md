# 011 Adapter Registry Selection And Persistence

Status: done
Owner: Tom
Updated: 2026-06-15

## Goal

Draft adapter registry selection and persistence semantics.

## Scope

- Define how configured adapter instances are selected for a project, task,
  model route, or explicit user choice.
- Define persistence expectations for adapter registry records without choosing
  the final storage backend.
- Define secret-reference and config-scope handling at selection time.
- Keep runtime ownership separate from durable registry identity.

## Out Of Scope

- Provider adapter implementation.
- Secret store implementation.
- Storage engine selection.
- UI picker behavior.

## Evidence Questions

- Which selection inputs are required before an adapter can receive work?
- How do project/session scoped overrides interact with instance defaults?
- What must persist across server restarts?
- What should be recomputed from health probes or runtime discovery?
- How should model-route selection differ from adapter-instance selection?

## Stop Conditions

- Adapter selection depends only on provider driver kind.
- Secrets are stored directly in registry records.
- Health snapshots become permanent capabilities.
- Model route identity replaces adapter instance identity.

## Promotion Targets

- `docs/contracts/009-adapter-registry-contract.md`
- `docs/contracts/002-harness-adapter-contract.md`
- `crates/nucleus-agent-adapters/src/`

## Validation

```sh
effigy qa:docs
effigy qa:northstar
cargo check --workspace
cargo test --workspace
```

## Next Task

Draft SCM/forge adapter implementation readiness plan.
