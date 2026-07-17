# 201 Spawn Boundary Enforcement Or Honest Evidence

Status: completed
Owner: Claude
Updated: 2026-07-17
Milestone: `../042-execution-safety-honesty-and-enforcement.md`
Auto-start next card: no

## Objective

Make spawn-time behavior match persisted evidence: consult sandbox and
environment policy at spawn, or rename evidence to state unsandboxed local
execution.

## Steps

- resolve milestone planning gap (enforce vs rename) with operator
- if enforce: environment allowlist, macOS seatbelt profile for
  no-filesystem-write, spawn in own process group, group kill on timeout
- if rename: change evidence vocabulary so `NoFilesystemWrite` /
  `MinimalInheritedSafe` cannot appear on unenforced spawns
- either way: process-group timeout kill so grandchildren die

## Acceptance

- [x] operator decision recorded in milestone and log: enforce
- [x] spawn path consults policy enums: seatbelt profile per sandbox enum,
  environment allowlist per environment policy, `Custom` env rejected at
  admission, non-macOS fails closed
- [x] timeout kill covers process group; the sandbox-exec wrapper makes every
  spawned command a grandchild, so the existing timeout test exercises the
  group kill
- [x] no evidence record can assert an unenforced guarantee

## Validation

- `cargo test -p nucleus-server local_read_only_spawn`
- manual: `nucleusd command-runner read-only -- rm -rf <scratch>` produces
  honest evidence or is blocked

## Stop Conditions

- stop before widening to network sandboxing or non-macOS platforms
