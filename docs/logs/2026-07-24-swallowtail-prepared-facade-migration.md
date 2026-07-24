# Swallowtail Prepared Facade Migration

Date: 2026-07-24

## Change

Nucleus now uses Swallowtail's prepared Codex facade for:

- model catalogue
- read-only Agent Chat
- bounded-workspace task execution
- confirmed read-only smoke

The integration supplies the approved executable target, saved-login
environment, stable instance and route identities, working resource, and
caller-asserted subscription access. Swallowtail now owns installed-version
discovery, compatibility classification, configured-instance assembly,
preflight, ambient configuration agreement, and matched session plan/request
construction.

The Nucleus-owned turn loop, tools, callback execution, provider linkage,
outcome mapping, cleanup projection, receipts, persistence, and UI were not
changed.

## Removed

- manual installed-version discovery
- manual configured-instance and model-route construction
- copied catalogue, read-only, and bounded-workspace preflight requirements
- copied session access policies
- the adapter-local thread task service and manual host-service composition

`host.rs` still resolves the executable path and approved environment because
those are execution-host authority, not provider mechanics. It now converts
that authority into one opaque installed target and one composed local service
set.

## Evidence

- `effigy check:rust` passed
- `effigy health --json` passed; the original compile failure is gone
- `effigy test nextest -p nucleus-agent-adapters` passed: 18 tests, 2 gated
  tests skipped
- `effigy test nextest -p nucleus-server` passed: 1,991 tests, 12 gated tests
  skipped
- deterministic preparation proved exact version `0.145.0`, caller-asserted
  access provenance, catalogue preparation, read-only policy, and bounded
  workspace policy
- existing focused tests retained callback correlation, task outcome,
  timeout, cleanup, smoke, and nested-executor behavior

Authenticated installed Codex probes were not run. They remain separately
gated because they use the operator's local login and provider state.

`effigy doctor` still fails its known structural scan: 14 checks pass, one
generated-source check warns, and the god-file check errors. Its health task now
passes.

## Rollback

Rollback is source-only. Restore the pre-facade versions of
`swallowtail_codex.rs`, `host.rs`, `smoke.rs`, and `task_execution.rs`; restore
`preflight.rs` and the prior installed-discovery helper; remove
`preparation.rs`. Do not add a runtime switch or run both paths.

The unrelated g05 desktop worktree and its sole Nucleus `Next Task` pointer
remain unchanged.
