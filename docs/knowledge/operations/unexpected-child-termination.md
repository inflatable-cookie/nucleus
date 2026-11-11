# Unexpected child termination: retained evidence and the attribution gap

Status: assessed; sender unknown (2026-10-24)
Tracking record: Nucleus papercut `3fdb066a-d012-4729-bf6a-03e943501c50`
"Unexpected child termination under load has no proven sender" (v5). The
papercut keeps the history and stays the owning record; this document bounds
what its evidence can and cannot establish.

This is a source and retained-evidence reconciliation. It claims no cause, adds
no Nucleus logger, guard, proof tuple or process-control code, and authorizes no
instrumentation. Two incidents are kept apart throughout:

- **Longhorn #060** (2026-10-20): PTY test children in one test binary died by
  signal 9 during `effigy release:floor` on Longhorn. This is the original
  unexpected-termination report.
- **Nucleus milestone QA `2b5183b3`** (2026-10-23, base `273fa430`): two of 3155
  tests failed. Their nested cause and sender are unknown, and this is **not**
  evidence of an external SIGKILL.

## Evidence table

Each row names the retained artifact. "Unavailable" means the underlying
observation was never retained, not that it was checked and disproved.

| # | Claim | Retained artifact | What it establishes | Available |
| --- | --- | --- | --- | --- |
| 1 | Four sessions in one binary reported `Signal(9)` in one floor run at head `95103849` | Nucleus task `longhorn#060` revision report, `2026-10-20T15:23:10.979Z`; PR #89 body (four named tests, "simultaneously") | Four victims, same binary, one run; the four test names | Yes |
| 2 | The test binary itself was not killed | The same reports: the binary survived to report all four child deaths | No SIGKILL reached the binary. *Inference, not separately recorded:* the sender did not signal the binary's own process group | Yes, as reported |
| 3 | Each victim was a PTY session in its own process group/session | PR #89 body; papercut v4 | Distinct victim groups is a code fact about `longhorn-pty` | Code fact only |
| 4 | No in-crate path could kill four distinct session groups | PR #89 body (author's audit: per-PID waits; kills only the caller's own still-unreaped group, exit-checked first; no `kill(-1)`, `killpg`, `libc::kill` or pattern kill; a child whose `setsid` fails never spawns); papercut v4 | The author's structural audit of the crate | Yes, as the author's audit; not independently reproduced from the fix source |
| 5 | Victim identities: `pid`, `ppid`, `pgid`, `sid`, start time, command | None. The reports carry test names, not process tuples. The task's `workspace_archived` event is `2026-10-20T16:20:59.834Z`, and the workspace directory no longer exists | Nothing | **Unavailable** |
| 6 | 18–27 GB of memory free throughout the failing run | Worker summary `2026-10-20T15:23:10.979Z`; papercut v4 | Argues against the OOM/jetsam path for that run | Summary only; the 10 s `vm_stat` monitor log is **unavailable** |
| 7 | Nucleus's own kill paths did not act in the recorded windows | Papercut v4, Supervisor `2422bc5e` read-only Nucleus audit: sweeps 13:50–15:00 terminated nothing; no host-run cancel or timeout 14:00–15:59; hook timeouts target the hook's own proven pgid plus start identity | Excludes those Nucleus paths **for those windows only** | Audit recorded in the papercut; its raw output is not separately retained |
| 8 | The 14:37Z floor report showed **one** victim, not four | Nucleus event `2026-10-20T14:37:48.877Z` (reviewer, head `2b01a47`): `stdin_round_trips_through_the_terminal` panicked with `Signal(9)`, 11 passed 1 failed | Corrects papercut v4's "14:37Z/15:23Z each show 4" | Yes |
| 9 | A later review of the next head failed with the same signature, then passed | PR #89 review `5588098472` (`2026-10-20T16:18:29Z`, approved at head `ca743947`): three floor runs on one clean tree — exit 1 with **four** simultaneous victims (`close_escalates_when_the_child_ignores_hangup`, `output_arrives_and_the_exit_result_follows_it_once`, `the_environment_is_exactly_the_supplied_map`, `child_has_a_controlling_terminal`), exit 1 with **two** (`close_escalates_when_the_child_ignores_hangup`, `operations_after_exit_are_classified_as_ended`), then exit 0 with 13/13. The Nucleus event `16:17:41.834Z` is that reviewer's report summarizing this review. The `15:38:21.859Z` revision report is **not** a new occurrence: it restates the `15:23:10Z` run and adds "Floor then passed green at this head" | A four-victim and a two-victim failure on the same tree, different victims each time, followed by green | Yes |
| 10 | Installed Effigy 0.14.1 has broad group and PID kill paths with no start-identity recheck | Effigy tag `v0.14.1` (commit `20465f1`), `crates/effigy-process/src/signal.rs:61-145`; similar in `crates/effigy-runtime/src/signals.rs:139`, `crates/effigy-deps/src/process.rs:199`, `crates/effigy-containers/src/exec/process.rs:466`, `crates/effigy-scan/src/execution/doctor_inventory.rs:1062` | The capability exists in that source (the papercut's `src/doctor_inventory.rs` path is actually `src/execution/doctor_inventory.rs`) | Source verified; no evidence it ran for this incident |
| 11 | No admission marker selected the targets | Papercut v4, Effigy planner `62fdcfea` source-only finding | Retires the earlier marker hypothesis; names no sender | Yes, as a source finding |
| 12 | Effigy's current custody design records the signals it sends | Effigy `main` at `7b82d2648`, contract 052 §5.7 (`StopReport.signals` — "only signals this process actually sent"), K6, K9, I-P4 | Names the producer record that would carry sender evidence | Source only; no installed-binary qualification |
| 13 | "v0.15 main" is a branch state, not a release | Effigy tags (no `v0.15*`) and `Cargo.toml` at `main` (workspace version `0.14.1`) | Corrects papercut v4's "v0.15 main" to a commit on `main` | Yes |
| 14 | Nucleus milestone QA `2b5183b3` failed 2 of 3155 tests at `273fa430`, both project-validation tests | Read-only store read of `project_qa_runs` (`state: failed`, exit 1; `failureIndexes`: 3155 tests, 2 failed, 36 skipped, `diagnosticsTruncated: true`; `failuresLog` names both: "project validation records a new argv digest after the command changes" — equal digests `dafc791d…` — and "project validation output past its limit keeps the tail and lets the exit code decide" — `null !== 0`); `host_run_records` outer run `settled`, `signal: null`, `timedOut: false`, no escaped descendants, no nested record | Both failing tests and their assertion diagnostics. **Unavailable:** the nested validation's own state, `outputTail` and `hostRunTelemetry.outcome` (they lived in the fixture store the test removes), so the nested cause and sender stay unknown | Partial |
| 15 | PR #617 and PR #618 are not retrospective attribution | Merge commits `cf7d65d3` (test-only settlement evidence in `test/prospective-merge-hooks.cases.ts`) and `21f4c657` (host-run CPU sampling) | They improve future evidence and separate CPU accounting. Neither identifies this sender | Yes |

Retained store reads were done read-only (no writes) on 2026-10-24. The task
detail command exposes the last 100 events (`core/store/store.ts:2165`), so the
14:37Z and 15:23Z reports above come from the retained event table, not from a
`queue.detail` window.

## What is excluded, and what stays open

- **Nucleus producer paths.** For the recorded windows in row 7, Nucleus's sweeps,
  host-run cancel/timeout and hook termination are excluded. Today's Nucleus
  signals are identity-scoped in source: the terminal sweep signals proven
  recorded groups and per-PID targets after a start-identity check
  (`core/machine/host-process-reap.ts`), hooks signal the occurrence's recorded group
  (`core/hooks/hooks.ts`), and milestone QA stops its own step group then reaps its
  own escapees per PID with a re-proven identity
  ([spec 035](../specs/035-host-run-scheduler.md)). That is the **current**
  shape, not proof about 2026-10-20.
- **Effigy 0.14.1 candidate paths.** Real code, unproven involvement. The
  retained signature (four session groups killed, the binary untouched) is
  inconsistent with a `signal_targets_for_child` group kill rooted at an
  ancestor of the binary, because that walk includes the root's own group. This
  narrows the candidate shape; it does not name a sender.
- **An agent pattern kill.** Repository guidance and memory record the
  fratricide hazard (papercut v4; PR #89 body), and PR #89's audit found no
  `pkill`/`killall` in sibling task scripts. No agent command line from the kill
  window is retained, so this stays a live candidate, not an attribution.
- **Memory pressure.** Free memory argues against OOM/jetsam for that run. It
  does not rule out every external cause.
- **A signal sender log.** SIGKILL cannot be caught, and macOS offers no
  unprivileged record of who sent one. Nothing retained identifies the sender,
  so the answer for Longhorn #060 is **UNKNOWN**. Nucleus milestone QA `2b5183b3`
  is also **UNKNOWN**, with a different and weaker evidence set.

No modern source fixes the old installed binary: the Effigy design in row 12 is
unreleased on this host, and no installed-binary qualification, install or
consumer credit follows from it.

## Bounded disposition

- The sender is unknown. Keep papercut `3fdb066a` as the owning record; this
  document bounds its evidence and does not close it.
- Do no further retrospective work on these two incidents: no `sudo`/`eslogger`,
  no OS, process or liveness probe, no signal tracing, no reproduction, no
  retry-until-green, no tool install.
- Make no Nucleus code change. A Nucleus-only logger would not see a foreign sender
  and would repeat the producer's job.
- Treat a later failure on its own evidence. Another Nucleus QA failure with an
  unknown nested cause is not a SIGKILL, and a green re-run proves nothing about
  a cause.

## Producer ownership

Sender evidence belongs to the producer that sends the signal, and each
producer already has an owning record:

- **Effigy** owns signal routing and delivery evidence for the runs it spawns:
  contract 052 K9 (one signal router), K6 (custody closure) and §5.7's
  `StopReport.signals`, which lists only signals that process actually sent.
- **Nucleus** owns its own terminations and records them: spec 035 for host runs
  and milestone QA, [spec 004](../specs/004-trusted-host-hook-runners.md) for
  hook occurrences, plus the terminal sweep's recorded facts.
- **Nothing** owns an agent's or a stray tool's signal, which is the actual gap.

So the smallest place to add attribution is the producer's own record, not a
new Nucleus facility and not a whole-host tracer. The 0.14.1 binary predates that
record shape (verified: no `StopReport`/`SignalDelivered` at `v0.14.1`), so an
occurrence on the installed binary cannot be attributed from it today.

## Future observation, if a reproduction happens

This is a proposal for a separate operator decision, not authority. It applies
only to a real reproduction and stops as soon as the sender is known.

1. From the failing binary's own output, print what the process already holds
   when a session reports an unexpected signal: the victim `pid` and the
   observed signal. Add `ppid`, `pgid`, `sid`, start time and command with one
   bounded platform read (for example `ps -o
   pid=,ppid=,pgid=,sess=,lstart=,command= -p <pid>`); that read is part of this
   proposal and needs the same authorization. Without it there is no new logger
   and no host-wide probe.
2. Retain whatever delivered-signal record the enclosing producer already keeps
   for that run. If the producer keeps none, record that as unavailable, never
   as exclusion.
3. Only if 1 and 2 still leave the sender unknown, the next step is a
   `sudo`/`eslogger` signal capture. Tom alone decides whether to authorize it,
   and this document does not.

Do not implement step 1 or any part of this list without that separate
selection; a proposal is not permission.
