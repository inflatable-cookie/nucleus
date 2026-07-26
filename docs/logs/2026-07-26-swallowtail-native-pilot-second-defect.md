# Swallowtail Native Pilot Second Defect

Date: 2026-07-26

## Outcome

The rebuilt bundled app revalidated exact `gpt-5.4-mini`, low reasoning, the
ChatGPT audience, and the isolated read-only fixture. Its first ordinary turn
failed before Codex `turn/start`:

`swallowtail.codex.app_server.preflight_mismatch`

Native proof evidence records one failed turn, zero active turns, and no
unexpected terminal class. The provider session opened and joined on app
close. No provider model turn, callback, fixture write, workspace write, or
retained Nucleus child occurred.

## Ownership And Repair

The prepared Swallowtail session plan omitted
`HostServiceKind::Time`. Nucleus correctly attached its configured bounded turn
deadline; the low-level driver correctly rejected a service absent from
immutable preflight.

Swallowtail commit `a26b54f0c264abf1712c94db442e9cb0b4078208`
now binds task, time, and process services for prepared interactive sessions.
Its regression starts and joins a deadline-bound prepared turn. All 90 Codex
adapter tests and 19 deterministic Nucleus adapter tests pass.

Nucleus requires no product-path change.

## Envelope State

The pilot has consumed 2 physical launches and catalogue attempts, 1 failed
turn, 1 of 3 reruns, and 1 joined provider-thread lifecycle. It has made zero
provider model turns.

The operator approved 5 physical launches and catalogue attempts
total, then executing the unchanged 12 planned outcomes across 3 clean
launches. The failed joined session counts within the unchanged 6-thread
maximum, leaving at most 5 further provider threads. The 15-turn, 3-live-child,
serial, read-only, and 60-minute cumulative active-execution limits remain.

## Next

Resume the native replay. Use the first ordinary turn as the repaired-path
gate and stop on deterministic drift.
