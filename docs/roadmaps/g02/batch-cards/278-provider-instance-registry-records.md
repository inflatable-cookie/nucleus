# 278 Provider Instance Registry Records

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../062-provider-runtime-materialisation-gate.md`

## Purpose

Add provider instance registry/config records before more provider commands.

## Scope

- Separate provider driver kind from configured provider instance.
- Record capability discovery posture, auth readiness, config evidence refs,
  and runtime ownership.
- Exclude credential material and hot reload behavior.

## Acceptance Criteria

- Provider instance ids remain distinct from provider driver kinds.
- Registry records can describe Codex now and other providers later.
- Credential material is represented only by non-secret refs where needed.

## Validation

- [x] targeted adapter/server tests
- [x] `cargo check --workspace`
- [x] `git diff --check`

## Stop Conditions

- Stop if provider instance config needs unresolved credential policy.

## Result

Added server-side provider instance registry records that separate configured
provider instances from provider driver kinds. Registry records now carry
capability discovery posture, auth readiness, config evidence refs, runtime
ownership, and optional provider service linkage.

Construction rejects config evidence marked as containing secret material and
keeps hot reload unsupported until a later explicit contract exists.
