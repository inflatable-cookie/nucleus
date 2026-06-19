# 2026-06-19 Codex Live Smoke Evidence

## Context

Nucleus needed one real Codex provider-write proof before promoting live
executor records into server-owned state.

The direct smoke ran through `nucleusd` after explicit operator approval.

## Protocol Sequence

Observed sequence:

- spawn local `codex app-server --stdio`
- send JSON-RPC `initialize`
- send JSON-RPC `initialized` notification
- send JSON-RPC `thread/start`
- send JSON-RPC `turn/start`
- wait for `turn/completed`
- terminate the local app-server process

## Smoke Policy

The smoke used:

- local Codex app-server
- current Nucleus checkout as working directory
- ephemeral thread
- read-only sandbox
- untrusted approval policy
- no callback response handling
- no cancellation or resume handling
- no task mutation

Prompt:

```text
Reply with exactly: nucleus codex direct smoke ok
```

## Sanitized Evidence

Allowed durable evidence fields:

- provider instance id
- app-server transport kind
- command method sequence
- write attempt id
- receipt id
- thread id
- turn id
- final turn status
- notification count
- server request count
- started/completed timestamps when available
- sanitized evidence refs
- cleanup status

Forbidden durable evidence fields:

- raw prompt text unless a later policy explicitly allows it
- raw provider response text
- raw JSON-RPC frames
- raw stdout
- raw stderr
- stream deltas
- model reasoning text
- tool payload bodies
- secrets or credential material

## Result

The approved smoke reached `turn/completed`.

The command output retained only sanitized ids, counts, and status fields. No
raw provider response material was recorded.

## Promotion

This evidence is enough to implement durable live executor outcome records.

It is not enough to:

- mutate task state from provider completion
- accept task work without review
- enable callback responses
- enable cancellation or resume execution
- generalize to other provider harnesses
