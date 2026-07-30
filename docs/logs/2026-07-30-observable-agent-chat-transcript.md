# Observable Agent Chat Transcript

Date: 2026-07-30
Status: completed

## Changed

- Nucleus requires prepared Swallowtail observable activity before opening
  Agent Chat.
- The adapter forwards public `ActivityObservation` values with runtime
  sequence. It does not parse Codex-native events.
- The server persists activity separately from canonical messages and replays
  both through conversation history.
- Tauri emits each durable activity observation to the calling window.
- Agent Chat now uses Poodle `AgentTranscript`. Poodle owns tool grouping,
  collapse, windowing, and scroll following.
- Nucleus owns delta/snapshot assembly, exact portable labels, final-message
  deduplication, receipts, cancellation, and product policy.

## Evidence

- focused adapter activity forwarding: pass
- focused activity projection and persistence: pass
- Bun transcript fixtures: 6 pass
- Svelte check: 0 errors; one pre-existing ProjectRail accessibility warning
- focused Rust check across protocol, adapter, server, and desktop: pass
- focused turn-history persistence tests: 7 pass
- diff check: pass

The compiled desktop source-guard test binary stalled before executing its
static test and was stopped. The same Agent Chat composition invariants now run
in the fast Bun fixture.

## Current State

Cards 014-016 are complete. A fresh debug app bundle rendered the empty Agent
Chat state and the stored 18-turn Nucleus Local transcript through Poodle.
Messages remained readable. Scrolling away from the end preserved position and
showed `Jump to latest`.

The first inspection had attached to a stale packaged app rather than the
current raw development executable. Rebuilding the `.app` explicitly removed
the false workspace-unavailable signal. The unavailable state now surfaces its
real load error when one exists.

The approved read-only turn displayed a reasoning summary, grouped command,
bounded command output, and exact final reply. Group and command collapse both
worked. Scroll stayed parked with `Jump to latest`.

The cancellation turn ran `sleep 20`. Cancellation returned in about 1.2
seconds, the forbidden completion reply did not appear, and the child process
joined. Restart then exposed one real gap: the last provider activity still
looked in progress because provider item lifecycle and turn terminal truth are
separate.

Nucleus now includes sanitized canonical turn status in conversation history.
Transcript reconstruction uses cancelled, timed-out, or failed turn truth to
settle still-open display activity and adds a separate terminal label. It does
not synthesize or persist a Swallowtail activity observation. The repaired
bundle reloads the cancelled work as a failure and shows `Turn cancelled`.

Cards 014-017 and roadmap 005 are complete. No implementation card is ready.
The next step is operator selection of the next g05 lane.

Project-layout card 003 and Forge manual validation remain operator-held.
