# Northstar AGENTS, Rust, And TypeScript Audit Closed

Date: 2026-08-31
Roadmap: `../roadmaps/g05/026-northstar-instruction-and-language-quality-audit.md`
Card: `../roadmaps/g05/batch-cards/108-northstar-agents-rust-typescript-audit.md`
Opened: `2026-08-31-northstar-instruction-language-quality-audit-opened.md`

## Outcome

Card 108 ran as one worker lane on `worker/northstar-agents-rust-typescript-audit`.
Both recorders finalized, the instruction chain was reviewed and optimized, and
51 files changed across four commits: 20 Cargo manifests and 4 policy records
from the approved setup tranche, 21 Rust sources and 4 TypeScript/Svelte
sources from recorded repair plans, and 2 `AGENTS.md` files. No report-only,
operator-decision, generated, read-only, or excluded file was touched.

## Compatibility Decision Applied

`rust-version = "1.95"` is set under `[workspace.package]` and inherited by all
19 workspace packages through `rust-version.workspace = true`. `cargo metadata`
resolves 1.95 for every package, and `cargo +1.95.0 check --workspace
--all-targets` exits 0. No other version, edition, toolchain, or dependency
policy changed.

## Quality Activation Installed

- `AGENTS.md` carries the marked `northstar:rust-quality` block; `apps/desktop/AGENTS.md`
  carries the marked `northstar:typescript-quality` block
- `docs/contracts/rust-quality-profile.json` and `rust-quality-deviations.json`
  (strict, 20 manifests, no accepted deviations)
- `docs/contracts/typescript-quality-profile.json` and
  `typescript-quality-deviations.json` (strict, one package, `base` + `svelte`
  overlays, no accepted deviations)
- Svelte 5.56.8 selects the Svelte 5 overlay. No SvelteKit package evidence
  exists, so the SvelteKit overlay was not applied and `SVELTE-SSR-001` has no
  applicable surface.
- The 302 ts-rs bindings under `apps/desktop/src/lib/control/generated/` and
  `apps/desktop/src/icons.generated.ts` are recorded as `exclusions.generated`;
  `apps/desktop/dist` is recorded as `exclusions.build_output`. None was edited.
  The generator boundary itself — `effigy desktop:bindings` plus the
  compile-time drift guard in `apps/desktop/src/lib/control/generatedContract.ts`
  — was inspected instead.

## Rust Audit

Repository scope, 22 disjoint assessed units covering the workspace root, all
19 packages, all 25 discovered targets, and both discovered features.
`nucleus-server` is partitioned into four units (`srv-control`, `srv-runtime`,
`srv-state`, `srv-support`) because 1457 files in one unit is not a coherent
repair wave.

- verdicts: 74 pass, 42 not applicable, 15 finding, 1 degraded
- findings: 16 (12 repaired under bounded plans, 4 retained)
- changed files: 21

Repaired: eight `RUST-READ-001` simplifications (identical-branch merge in the
command policy, an unreachable `cancelled` arm, `is_empty()` consistency,
derived `Default`, `is_none_or`, `&Path` parameters, `slice::from_ref`,
needless borrows, `is_multiple_of`) and four `RUST-API-001` `Debug` derives on
public types that carry no protected data.

Retained findings:

- `F-SRVRT-UNSAFE-1` — the single `unsafe` block in the repository
  (`libc::kill(-group, SIGKILL)` in `local_read_only_spawn/spawn.rs`) has no
  SAFETY comment. The obligation is discharged in practice because
  `spawn_and_wait` sets `command.process_group(0)`, so the child is its own
  group leader. `RUST-UNSAFE-001` remediation authority is report-only, so the
  audit records the obligation and does not write the comment.
- `F-DESK-ERR-1` — `apps/desktop/src-tauri/src/state.rs` turns an unwritable
  task-review snapshot root into a panic inside a public constructor. Repair
  needs a `Result` constructor and a reshaped Tauri setup path: a public API
  and visible-behaviour decision card 108 does not settle.
- `F-ADAPT-API-2` and `F-PROTO-API-1` — four public types cannot take a derived
  `Debug`; `AgentUserInputWait`/`AgentUserInputAnswerer` would render operator
  question content, which `RUST-API-001` exempts as protected data. A redacted
  manual implementation is a product decision.

Exact-forwarder candidate ledger (`RUST-SLOP-001`, evaluation-only, no repair
authority). stopslop 0.5.1 SLOP039 over all owned Rust paths returned four
candidates, each classified independently under `RUST-READ-001` and retained:

- `apps/desktop/src-tauri/src/editor_drafts.rs:82` — `#[tauri::command]`
  boundary name the frontend invokes
- `crates/nucleus-agent-protocol/src/codex/fixtures.rs:260` — intent naming in
  the shared Codex fixture surface
- `crates/nucleus-engine/src/run_commands/model.rs:225` — storage-payload
  naming seam
- `crates/nucleus-server/src/accepted_memory_projection_write_admission.rs:274`
  — test-facing naming seam

## TypeScript And Svelte Audit

Repository scope over the owned `apps/desktop` package, 7 disjoint units across
131 hand-written source, test, and configuration files.

- findings: 7 (4 repaired, 3 retained)
- changed files: 4

Repaired, all `TS-EVIDENCE-001`: `editorNavigation.ts` now dispatches typed
`CustomEvent` details and exports a structural reader; `FilesSidebarView.svelte`
narrows the active-editor-file payload instead of asserting it; `App.svelte`
reads panel command-state flags structurally instead of through `detail: any`;
`tsconfig.json` includes `vitest.config.ts`, taking the checked project from
1368 to 1381 files with 0 errors.

Retained:

- `TS-EVIDENCE-001/tighten_compiler_options` — `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noUnusedLocals`, `noUnusedParameters`, and
  `noImplicitOverride` are all off. Measured: enabling them reports 280 errors
  across 81 files. That is a package-wide typing programme, not a bounded audit
  repair.
- two `TS-SLOP-001` ledger entries (evaluation-only): `TerminalTransport` is a
  single-implementation interface that is retained because it names the host
  terminal contract and types the exported singleton; the SLOP009 hit on
  `DEFAULT_BROWSER_URL = "https://example.com"` is a scanner false positive that
  matches the Rust-side constant.

`TS-BOUNDARY-001` passed rather than producing a finding: `invoke<T>` asserts
the IPC payload, but every response is narrowed through a discriminated
`response.body.type` switch with an explicit `unexpected` arm, and the DTO
contract is guarded against the Rust source at `svelte-check` time by
`generatedContract.ts`. `SVELTE-A11Y-001` is backed by 0 svelte-check warnings
across 1381 files. Async lifecycle review found `addEventListener` and
`removeEventListener` balanced in all twelve components that register listeners.

## Instruction Review

Section-intent map of the pre-review file, with the disposition taken:

| Section | Intent | Force | Disposition |
| --- | --- | --- | --- |
| `# Nucleus Agents` + `Scope:` | name the file's reach | boundary | rewritten for intent: it named scope but never the project, so a first-time agent met prohibitions before orientation. Now carries identity plus the four properties a change must not break. |
| Always-loaded boundaries: planning authority | stop guessing a parallel plan | boundary | merged with the adjacent planning-ambiguity bullet; both stated one rule. |
| Always-loaded boundaries: worker mode | keep a normal agent out of worker mode and stop relative sibling-handoff resolution | boundary | rewritten for intent. Eight lines restated contract 034 almost verbatim while the same file pointed at 034 twice. Compressed to the trigger, the absolute-path rule, the stop, and the pointer. |
| Always-loaded boundaries: contracts before behavior | protect spec-first posture | boundary | retained verbatim. |
| Always-loaded boundaries: release/CI | protect irreversible surfaces | boundary | retained verbatim. |
| Always-loaded boundaries: worktree layout | keep the Longhorn sibling link intact | boundary | rewritten for intent. The rule was keyed to `.t3/worktrees/nucleus/<id>`, a harness this repository no longer launches from, which made the boundary look inapplicable under Paseo. Restated from the durable cause — `apps/desktop` Cargo and Bun path dependencies resolve through the checkout's parent — with the consequence named and the create/reuse/stop/never-overwrite and no-git-pin rules unchanged. Manual worktree locations now point at contract 035. |
| Common commands | verified first-move commands | default | retained and extended: `effigy qa` and `effigy qa:docs` are the completion gate and were absent. The baseline doctor degradation is named so a degraded run is not read as a licence to widen a lane. |
| Docs authority | canonical pointers | boundary | retained, annotated with what the three contracts own. |
| Project posture | doc-kind vocabulary | maintainer taste | merged into Docs authority; it defines the same list it followed and read as a separate topic. |
| Papercuts paragraph | ongoing observation loop | default | retained, kept adjacent to the working-rules pointer that owns it. |
| Rust code shape | keep a very large workspace navigable | maintainer taste | retained; the reason (`nucleus-server` is over a thousand files) was missing and is now stated. |
| Read on demand | where to look next | default | retained, trimmed of the duplicate contract pointers now carried in Docs authority. |
| `northstar:rust-quality` block | tool-managed activation | boundary | untouched; byte-identical between its markers. |

`AGENTS.md` gained an orientation opening — what Nucleus is, and the four
properties a change must not break — which contract 034 asks the root surface
to carry and the file did not have. The inlined worker-mode paragraph was
compressed to its trigger and stop with a pointer to contract 034. The Longhorn
sibling rule was restated from the dependency graph (`apps/desktop` Cargo and
Bun path dependencies resolve through the checkout's parent) instead of the
stale `.t3/worktrees/nucleus/<id>` harness layout; its create, reuse, stop, and
never-overwrite boundaries and the no-git-pin rule are unchanged. `effigy qa`
and `effigy qa:docs` are now named as the completion gate.

Every authority, stop, release, worktree, sibling-link, validation, papercut,
and language-quality activation boundary survives. `CLAUDE.md` is still exactly
`@AGENTS.md`. The tool-managed `northstar:rust-quality` block is byte-identical.

Checker: 69 non-blank lines / ~864 tokens before, 94 / ~1329 after; 13 of those
lines are the installed `northstar:rust-quality` block.

## Coverage Limitation

Both audits are lead-driven, not exhaustive line-by-line reads. The Rust surface
is 1903 files and about 299,000 lines; strict-lint and scanner sweeps covered
100% of it, and manual source reading targeted flagged sites, module front
doors, and the named risk boundaries. Each unit's verdict and attestation
evidence states that coverage claim, and `srv-control` carries an explicit
`degraded` `RUST-READ-001` verdict with a `partial_manual_coverage` limitation.
The TypeScript surface is 131 hand-written files and about 25,000 lines and was
reviewed more closely.

The finalized Rust result is `degraded`, not clean: 15 evidence records are
warning-bearing and 4 findings are retained. Six of the warning-bearing compiler
and test records count `ts-rs` and `ts-rs-macros` dependency build artifacts
rather than Nucleus source diagnostics; a matching human-readable-format record
(`compiler-text-*`) is recorded alongside each and passes with zero warnings.
Both records are retained.

## Baseline Doctor State

`effigy doctor` was degraded before this lane and remains degraded. Card 108 did
not authorize structural repair, so no god-file or generated-in-source finding
was touched.

Measured in this worktree:

| | before | after |
| --- | --- | --- |
| summary | `ok:17 warn:1 err:2` | `ok:18 warn:1 err:1` |
| `scan.god-files` | 293 findings, 13 errors | 293 findings, 13 errors — unchanged |
| `scan.generated-in-src` | 302 warnings | 302 warnings — unchanged |
| `health.task.execute` | error, exit 101 | resolved |
| `dependencies.link-health` | info, healthy | info, healthy |

The `health.task.execute` error is not a repair. `health` runs `check:rust`,
which fails while `apps/desktop/dist` is absent because `tauri::generate_context!`
requires the built `frontendDist`. Running `effigy desktop:build` once in this
fresh worktree produced that output; no tracked file changed.

Two opening-log baseline items are corrected against the worker environment
rather than dropped: dependency link health reports `healthy` here for both the
24 committed Cargo path dependencies and the 3 committed Bun `file:`
dependencies, and no stale-graph finding reproduced. The god-file and
generated-in-source baselines stand exactly as recorded.

## Records

Recorder records live outside the tracked tree and are not committed:

- Rust: `<git-dir>/northstar/rust-quality/audits/nucleus-card108-rust/`
  (`result.json`, `report.md`, per-unit assessments and completions, 60 sealed
  evidence records)
- TypeScript: `.effigy/typescript-quality/audits/nucleus-card108-ts/`
  (`result.json`, per-unit records) — `.effigy` is git-ignored

## Validation

- `cargo +1.95.0 check --workspace --all-targets` — exit 0
- `effigy qa` — exit 0 (docs, northstar, Longhorn consumer boundary, cargo check,
  cargo test --workspace, nucleusd smoke, svelte-check, desktop tests)
- `effigy qa:docs` — pass
- `effigy qa:northstar` — pass
- installed Northstar instruction checker — pass, bridge OK
- `bun run check` in `apps/desktop` — 1381 files, 0 errors, 0 warnings
- `bun run test` in `apps/desktop` — 71 bun tests, 38 vitest tests, 0 failures
- `git diff --check` — clean

No native GUI proof was run. No release mutation, CI change, or dependency or
toolchain change was made.
