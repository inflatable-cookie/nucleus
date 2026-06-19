# 303 Codex Direct Real Write Decision

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../067-codex-direct-connection-smoke-gate.md`

## Purpose

Decide whether to run the first real Codex `turn/start` provider-write smoke.

## Scope

- Review the dry-run boundary output.
- Confirm the intended provider instance and local environment.
- Confirm that the test prompt, working directory, retention policy, and
  rollback expectations are acceptable.
- Run the real provider write only after explicit operator approval.
- Record sanitized evidence from the run or keep the gate blocked.

## Decision Review

Dry-run evidence:

- default command: `status=blocked`
- default blockers: `smoke_intent_disabled_by_default`,
  `operator_confirmation_missing`
- confirmed command: `status=eligible`
- both modes: `provider_write_executed=false`
- both modes: `raw_payload_retained=false`
- both modes: `raw_stream_retained=false`
- both modes: `task_mutation_permitted=false`

The confirmation flag currently proves only that the local boundary can reach
eligible state. It is not the real provider write.

Required approval shape:

- name the Codex provider instance to target
- name the working directory or confirm no project directory should be touched
- approve the exact smoke prompt
- approve no raw payload or stream retention
- approve that task mutation, callback response, cancellation, and resume stay
  disabled
- explicitly say to run the real Codex direct-connection `turn/start` smoke

Suggested narrow prompt:

```text
Reply with exactly: nucleus codex direct smoke ok
```

Suggested retention policy:

- store only sanitized evidence refs and receipt ids
- do not persist raw provider request payloads
- do not persist raw provider stdout, stderr, JSON frames, or stream deltas
- do not commit any provider response material

Live smoke evidence:

- command: `nucleusd command-runner codex-turn-start-real-write-smoke
  --confirm-real-write --execute-provider-write`
- provider instance: local Codex app-server via `codex app-server --stdio`
- working directory: current Nucleus repository checkout
- prompt: `Reply with exactly: nucleus codex direct smoke ok`
- thread start: succeeded
- `turn/start`: succeeded
- final observed turn status: `completed`
- server requests seen: `0`
- raw payload retained: `false`
- raw stream retained: `false`
- task mutation permitted: `false`
- provider response text: not recorded

## Acceptance Criteria

- [x] Dry-run output is reviewed and recorded.
- [x] Operator explicitly approves or rejects the real provider-write smoke
      with the required approval shape.
- [x] If approved, the run uses the narrowest possible `turn/start` payload.
- [x] If approved, no raw provider material is committed.
- [x] If rejected, the roadmap records the next hardening target.

## Validation

- dry-run `nucleusd` command output
- targeted `nucleusd` tests before any live run
- post-run evidence review if approved

## Stop Conditions

- Stop if provider identity, credentials, payload scope, or retention policy is
  unclear.
- Stop if approval is phrased as a generic continuation rather than explicit
  real-provider execution approval.
