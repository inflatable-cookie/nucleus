# Interactive And Structured Agent Chat

Date: 2026-07-31
Status: lane complete

## Changed

- Promoted typed-question, immutable harness-mode, portable activity, and
  observational child-topology rules into Contracts 010, 019, 024, and 030.
- Replaced the obsolete callback match with Swallowtail
  `HarnessUserInput`.
- Added an exact-once typed-question rendezvous whose answer route does not
  require the serialized chat-session lock.
- Persisted pending, answered, terminal, and restart-abandoned question truth.
  Secret answer text is redacted before storage.
- Composed pending questions through Poodle `AgentQuestion` in
  `AgentChatInput`; durable answers replay through `AgentTranscript`.
- Added explicit normal/plan mode to request, storage, effective-session
  evidence, route matching, Swallowtail preparation, and the composer. Native
  acceptance made the mode an adjacent, always-visible toggle rather than a
  nested model capability.
- Preserved portable actor, task-list, and subagent snapshot fields through
  Nucleus storage and desktop DTOs.
- Presented provider plans and task lists as read-only transcript structure
  with item status, priority, replacement, clear, and child attribution.
- Folded child observations through one Swallowtail directory per exact runtime
  operation and persisted first-seen order, unknown placeholders, and last
  observed state.
- Added durable main/child transcript selection. Child selection is validated
  against the exact operation-local directory and survives restart.

## Boundaries Preserved

- No Codex-native event or provider payload parsing was added.
- Provider task lists do not create, update, or promote Nucleus Tasks.
- Harness plan mode remains distinct from plan activity and open-ended planning
  conversation.
- Subagent data is observational. No child control route or affordance exists.
- Task execution retains its explicit unsupported typed-question policy.

## Evidence

- focused protocol question-rendezvous tests
- focused server question-registry, restart, and activity replay tests
- desktop transcript fixtures for answered, secret, restarted, task-list, and
  exact operation-local child-attributed presentation
- focused subagent-directory reducer, persistence, restart, and selection tests
- desktop Svelte check
- `effigy check:rust`
- docs QA

## Native Acceptance

The operator authorized one bounded authenticated pass. Nucleus ran against an
isolated state root and read-only fixture with Codex CLI `0.146.0`, ChatGPT
login, `gpt-5.4-mini`, low reasoning, and Plan mode.

The typed question rendered in the Poodle composer. Selecting `README.md`
cleared the wait state and produced one durable answered-question record. The
initial run then failed at `serverRequest/resolved` before task-list or
child-work acceptance.

The local Codex schema permits both string and integer `RequestId` values for
`serverRequest/resolved`. Swallowtail already normalizes both at callback start,
but its resolution activity projection required text. Swallowtail fixed that
boundary with a representation-aware portable provider request reference.
Nucleus did not parse or persist the native payload to work around it.

Nucleus rebuilt against Swallowtail
`1d7b8b3a4a3b124b1b36e650bd3b8dd6b425a1c7` and reran the bounded case from a
fresh isolated state root. The answer resumed the exact live turn. Plan mode
remained selected and immutable. Codex published plan commentary and completed
one `spawnAgent` call.

The first child-owned activity then failed with `Codex app-server event belongs
to a different provider session`. Current Swallowtail activity ownership checks
all ordinary notification envelopes against the root provider thread ID. A
real child may instead use the exact child thread ID established by the prior
collaboration result. The shared adapter must admit those known
operation-local child IDs without admitting arbitrary foreign sessions.

Swallowtail commit `780a7d4fb3520ac75b58994b576c1236d0116298` added
that bounded ordinary-activity admission. A third fresh Nucleus run confirmed
the completed spawn observation and persisted its exact child as pending. The
next provider notification still failed with the same session-mismatch class
before any child-attributed activity was persisted.

Swallowtail commit `c7d20b0000528774e5c384b72c922fec5725117e` then
added child-local turn lifecycle observation. A fourth fresh run completed.
The exact spawned child retained attribution across start, reasoning,
assistant output, command execution, and completion. The root completed
separately. The child directory ended at `completed`, survived restart, and
supported exact child transcript selection. The run reported one completed
turn and zero failed, active, or unexpected terminal turns.

Codex `0.146.0` rejects `update_plan` while harness Plan mode is active. Nucleus
therefore ran task-list acceptance separately in Normal mode. Four portable
snapshot replacements advanced three ordered items to completion. All
priorities remained null and were not invented. The final snapshot persisted
through restart. Explicit status labels replaced Markdown checkbox syntax so
the native UI and accessibility tree now expose `Completed`, `In progress`, or
`Pending` rather than indistinguishable bullets. That run also reported one
completed turn and zero failed, active, or unexpected terminal turns.

## Residual Risks

- Provider task-list priority is unavailable from Codex `turn/plan/updated`;
  Nucleus must continue showing priority only when the provider supplies one.
- Direct child spawn, steering, interruption, resume, and deletion remain
  unsupported. Child topology is observational.
- Provider auto-resolution deadlines are preserved, but Nucleus does not yet
  synthesize an automatic operator answer.
- A pending answerer cannot survive process restart; the durable abandoned
  record is visible and deliberately unanswerable.
- Doctor still reports the 25 pre-existing oversized-file findings outside this
  lane.

## Next

Return to the operator for the next g05 consolidation lane. Project-layout
card 003 and Forge native validation remain operator-held.
