# 021 Steward Persona Policy And Sync Authority

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Draft steward persona policy and sync authority semantics.

## Scope

- Define the project steward's authority boundaries.
- Separate management-state sync authority from code-change authority.
- Define approval gates for commit, push, conflict resolution, task deletion,
  and sync-policy changes.
- Connect steward policy to `nucleus-native-harness` persona and tool policy
  types.
- Promote durable rules into the native harness and SCM contracts.

## Out Of Scope

- Implementing steward execution.
- Implementing Git sync.
- Implementing model routing for steward personas.
- Implementing UI controls for approvals.

## Evidence Questions

- Which steward actions can run unattended?
- Which actions can prepare changes but require approval before commit?
- Which actions require approval before push?
- Which actions are forbidden under management-sync authority?
- How should semantic conflicts be distinguished from mechanical conflicts?
- Which policy fields must be represented before implementation begins?

## Stop Conditions

- Steward authority is allowed to mutate code through management-sync policy.
- Push behavior is implicit.
- Task deletion or history rewrite lacks an approval rule.
- Native persona policy depends on model backend choice.

## Promotion Targets

- `docs/contracts/012-native-harness-runtime-contract.md`
- `docs/contracts/011-scm-forge-sync-contract.md`
- `crates/nucleus-native-harness`

## Validation

```sh
effigy qa:docs
effigy qa:northstar
cargo check --workspace
cargo test --workspace
```

## Next Task

Draft management projection file model.
