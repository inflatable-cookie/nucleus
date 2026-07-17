# 042 Execution Safety Honesty And Enforcement

Status: completed
Owner: Tom
Updated: 2026-07-17

## Purpose

Make command-execution safety claims true: either enforce the sandbox and
environment policies that evidence records assert, or rename the evidence so
nothing downstream can trust an unenforced label.

Audit basis: `../../logs/2026-07-17-codebase-audit-findings.md` (critical
finding 1).

## Governing Refs

- `../../contracts/001-working-rules.md`
- `../../contracts/020-runtime-receipt-contract.md`
- `g01/028-host-execution-safety-and-artifact-policy.md` (evidence)

## Planning Gaps

- [x] decide enforce-vs-rename: operator chose enforce (macOS seatbelt, env
  allowlist, process-group kill; non-macOS fails closed)

## Execution Plan

- [x] Add a real policy evaluation function to `nucleus-command-policy`
  (request -> allow/deny decision) and replace the shell-basename denylist.
- [x] Enforce or rename at the spawn boundary: consult
  `CommandSandboxProfile` / `CommandEnvironmentPolicy` at spawn time, filter
  environment, kill the process group on timeout — or downgrade the persisted
  evidence wording.
- [x] Remove fabricated operator-confirmation evidence: `--confirm-real-write`
  must not mint a `Confirmed` record from a bare flag.
- [x] Validate that no persisted evidence record asserts a guarantee the
  runtime does not enforce.

## Goals

- [x] evidence records and runtime behavior agree everywhere
- [x] policy decisions live in `nucleus-command-policy`, tested as pure logic

## Acceptance Criteria

- [x] `nucleusd command-runner read-only -- rm -rf <tmp>` is blocked before
  spawn (`DestructiveExecutable`) and the target survives; sandboxed spawns
  can no longer write under `NoFilesystemWrite` (seatbelt-enforced, tested)
- [x] `python -c`, `node -e`, `dash` no longer bypass the interpreter guard
- [x] timeout kills grandchildren (process group); sandbox-exec wrapper makes
  every command a grandchild, so the timeout test exercises the group kill
- [x] operator confirmation is typed by source: CLI-flag assertion is a
  distinct variant with `assertion:cli-flag:*` refs, never `Confirmed`
  evidence

## Batch Cards

Planned:

- `batch-cards/200-command-policy-evaluation-function.md`
- `batch-cards/201-spawn-boundary-enforcement-or-honest-evidence.md`
- `batch-cards/202-operator-confirmation-integrity.md`
