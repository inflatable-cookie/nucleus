# Interactive And Structured Agent Chat

Date: 2026-07-31
Status: deterministic implementation complete through card 023

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
  evidence, route matching, Swallowtail preparation, and the composer picker.
- Preserved portable actor, task-list, and subagent snapshot fields through
  Nucleus storage and desktop DTOs.
- Presented provider plans and task lists as read-only transcript structure
  with item status, priority, replacement, clear, and child attribution.

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
  child-attributed presentation
- desktop Svelte check
- `effigy check:rust`
- docs QA

No authenticated provider work ran in this batch.

## Residual Risks

- Operation-local `SubagentDirectoryProjection`, durable child selection, and
  attributed transcript navigation remain card 024.
- Provider-version behavior for plan mode, typed questions, and child topology
  still needs the separately gated native card 026.
- Provider auto-resolution deadlines are preserved, but Nucleus does not yet
  synthesize an automatic operator answer.
- A pending answerer cannot survive process restart; the durable abandoned
  record is visible and deliberately unanswerable.
- Doctor still reports the 25 pre-existing oversized-file findings outside this
  lane.

## Next

Execute card 024: fold snapshots into one Swallowtail
`SubagentDirectoryProjection` per runtime operation, persist the Nucleus-owned
directory and selection state, then add read-only main/child/unknown transcript
navigation.
