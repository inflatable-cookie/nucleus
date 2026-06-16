# 004 Adapter Contracts Fixtures And Effects

Status: complete-first-pass
Owner: Tom
Updated: 2026-06-16

## Goal

Define provider-neutral adapter traits, command authority policy, dev-only
fixtures, contract tests, fake adapters, and first runtime effect vocabulary.

## Scope

- Command execution authority and sandbox policy.
- Provider-neutral fake adapter and fixture plan.
- Dev-only contract fixture crate.
- Provider-neutral contract tests and fake adapter scenario tests.
- Production adapter trait boundary and skeleton.
- Adapter runtime effect request/outcome skeletons.

## Out Of Scope

- Provider adapter implementation.
- Command runner implementation.
- Runtime scheduler implementation.
- Live provider credentials or network tests.

## Execution Plan

- [x] Define command authority and sandbox policy.
- [x] Define dev-only fixture crate boundary.
- [x] Scaffold fixture crate and provider-neutral tests.
- [x] Add fake adapter skeletons and scenario tests.
- [x] Draft and add production adapter trait skeletons.
- [x] Draft and add adapter runtime effect request/outcome vocabulary.

## Acceptance Criteria

- [x] Production crates do not depend on the dev-only fixture crate.
- [x] Fake adapters do not execute commands, access providers, or read secrets.
- [x] Adapter traits describe static capability and authority needs without
  implementing runtime behavior.
- [x] Runtime effect request/outcome types stay separate from scheduler and
  transport implementation.

## Cards

- `docs/roadmaps/g01/batch-cards/032-command-execution-authority-and-sandbox-policy.md`
- `docs/roadmaps/g01/batch-cards/033-provider-neutral-fake-adapter-and-fixture-plan.md`
- `docs/roadmaps/g01/batch-cards/034-dev-only-fixture-crate-boundary-and-contract-test-plan.md`
- `docs/roadmaps/g01/batch-cards/035-scaffold-dev-only-contract-fixture-crate.md`
- `docs/roadmaps/g01/batch-cards/036-add-first-provider-neutral-contract-tests.md`
- `docs/roadmaps/g01/batch-cards/037-add-provider-neutral-fake-adapter-skeleton.md`
- `docs/roadmaps/g01/batch-cards/038-add-fake-adapter-scenario-script-tests.md`
- `docs/roadmaps/g01/batch-cards/039-draft-production-adapter-trait-boundary.md`
- `docs/roadmaps/g01/batch-cards/040-add-production-adapter-trait-skeleton.md`
- `docs/roadmaps/g01/batch-cards/041-add-production-adapter-trait-compile-tests.md`
- `docs/roadmaps/g01/batch-cards/042-draft-adapter-runtime-effect-boundary.md`
- `docs/roadmaps/g01/batch-cards/043-add-adapter-runtime-effect-type-skeleton.md`
- `docs/roadmaps/g01/batch-cards/044-add-adapter-runtime-effect-type-compile-tests.md`

## Planning Gaps

- Runtime scheduler and async runtime are not selected.
- Provider-specific adapter implementation order still needs an implementation
  roadmap.
