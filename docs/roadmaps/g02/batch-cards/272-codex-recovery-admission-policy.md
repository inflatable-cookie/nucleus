# 272 Codex Recovery Admission Policy

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../061-codex-session-recovery-gate.md`

## Purpose

Gate Codex recovery/resume attempts before provider send.

## Scope

- Require explicit recovery authority.
- Require provider identity evidence and supported resume capability.
- Block unsafe replacement-thread or missing-thread cases.
- Keep provider send out of this card.

## Acceptance Criteria

- [x] Admission reports accepted, blocked, and unsupported states.
- [x] Blockers are actionable and replay-safe.
- [x] Task state is not mutated by admission.

## Closeout

Added Codex recovery admission records that gate recovery/resume attempts
before provider send. Admission now requires recovery authority, runtime-ready
evidence, provider-identity evidence, thread-resume capability, provider
thread identity, and raw payload policy confirmation.

Unsafe replacement-thread and provider identity mismatch cases are blocked.
Repair-only and unsupported resume capabilities are reported as unsupported.
Admission records never start provider send, retain raw provider payloads, or
permit task mutation.

## Validation

- [x] `cargo test -p nucleus-server recovery -- --nocapture`
- [x] `cargo check --workspace`
- [x] `git diff --check`

## Stop Conditions

- Stop if recovery policy needs unresolved operator intent.
