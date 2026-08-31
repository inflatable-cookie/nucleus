# 026 Northstar Instruction And Language Quality Audit

Status: complete
Owner: Tom
Created: 2026-08-31

## Purpose

Audit Nucleus's always-loaded agent instructions and both implementation
languages through Northstar's explicit recorders. Repair only findings whose
catalogue authority permits repair, then leave one evidence-backed PR.

This is an independent maintenance lane inside g05. It does not select g06,
resume deferred product work, or satisfy the pending orchestration product
checkpoint.

## Governing Refs

- `../../contracts/001-working-rules.md`
- `../../contracts/034-agent-instruction-surface-contract.md`
- `../../contracts/035-agent-local-paths-contract.md`
- `../../architecture/system-architecture.md`
- `../../architecture/product-guardrails.md`
- `../../architecture/repository-authority-map.md`
- Northstar's explicit Rust, TypeScript/Svelte, and AGENTS review workflows

## Scope

- install the missing Northstar Rust and TypeScript quality activations,
  profiles, and deviations records before either audit starts
- declare Rust 1.95 as the workspace MSRV, matching Longhorn's dependency
  floor, and make every workspace package inherit it
- run a repository-scope Rust audit over the workspace root and all 19 Cargo
  packages, targets, features, public APIs, and risk boundaries
- run a repository-scope TypeScript/Svelte audit over `apps/desktop`, applying
  the Svelte 5 overlay and treating generated control bindings as
  generator-owned read-only output
- review the complete applicable AGENTS chain, keep `CLAUDE.md` as the exact
  one-line bridge, and optimize instructions only where repository evidence
  supports the change
- record retained findings and baseline limitations without presenting them as
  repaired or as new execution authority

## Boundaries

- no native GUI proof, release mutation, CI/workflow edit, dependency or
  toolchain migration, broad architecture rewrite, or deferred product lane
- no hand edits to generated TypeScript bindings
- no public API, persistence, security, concurrency, error-contract, or other
  operator-decision change under audit repair authority
- no blanket god-file splitting, formatting, lint fixing, or slop deletion
- the existing doctor findings are baseline evidence, not repair scope

## Baseline

The planning checkout is clean at `1e23d376`. Discovery found 19 Cargo
packages and 431 TypeScript/Svelte files under `apps/desktop`.

`effigy doctor` is already degraded:

- two local Bun registrations have no desired link ledger
- god-file scan: 293 findings, including 13 errors
- generated-in-source scan: 302 warnings
- graph index stale

The worker must preserve and report this baseline. A clean audit claim cannot
erase it, and a degraded doctor result cannot widen the card.

## Review Oracle

| Invariant | Smallest counterexample | Required proof |
| --- | --- | --- |
| Scope is complete | One Cargo package, target, feature, hand-written desktop source, or applicable instruction file has no disposition | Recorder inventories reconcile with Cargo metadata, package ownership, source counts, exclusions, and the final report |
| Policy precedes repair | Source changes appear before the relevant recorder initialization, or the MSRV/profile changes after initialization | Setup and Rust 1.95 policy are recorded first; recorder snapshots precede every audit-owned source repair |
| Repair authority stays narrow | A report-only, operator-decision, generated, read-only, or excluded file changes | Finding, repair-plan, extension, and changed-file attribution prove every mutation; protected files retain their hashes |
| Compatibility changes only as approved | A package does not inherit 1.95, or another version/toolchain policy changes | Cargo metadata shows Rust 1.95 for every package and the diff contains no wider version-policy change |
| Language evidence is honest | A failed, warning-bearing, unavailable, or unrun selector is presented as a pass | Rust and TypeScript records retain actual status, diagnostics, warnings, failure stage, and limitations |
| Product boundaries survive | TypeScript gains durable authority, secrets enter state or logs, or a repair changes persistence/concurrency/public API behavior without a decision | Architecture/contract trace plus focused negative tests; unresolved contract choices are reported and left unchanged |
| Instructions retain intent | Worker, release, sibling-link, stop, validation, or authority rules disappear; Claude gains duplicate guidance | Section-intent map, before/after measurements, exact bridge proof, and final diff review |
| Baseline is not laundered | The PR claims doctor clean or silently repairs unrelated scan leads | Before/after doctor evidence and closeout limitations name unchanged or deliberately excluded findings |

## Outcome

Card 108 closed on `worker/northstar-agents-rust-typescript-audit`. Closeout:
`../../logs/2026-08-31-northstar-agents-rust-typescript-audit-closed.md`.

Oracle reconciliation:

| Invariant | Result |
| --- | --- |
| Scope is complete | Rust plan carries the exact Cargo inventory (1 workspace, 19 packages, 25 targets, 2 features) and the tool rejects any mismatch; 22 units own all 1903 tracked `.rs` files with no overlap. TypeScript manifest owns all 131 hand-written `apps/desktop` source, test, and config files; the 302 generated bindings, `icons.generated.ts`, and `dist` carry recorded exclusions. |
| Policy precedes repair | The MSRV and activation tranche is commit `c385426e`, before either recorder was initialized. All 22 Rust assessments and all 7 TypeScript assessments were recorded before the repair commits `d601fa57` and `3be88ef6`. |
| Repair authority stays narrow | 51 changed files: 21 attributed to 12 Rust repair plans, 4 to 4 TypeScript repair plans, 20 Cargo manifests and 4 policy records from the approved setup tranche, and 2 `AGENTS.md` files (one tool-installed block, one instruction-lane rewrite). Both recorders verify read-only and excluded file hashes at completion and finalization; both finalized without a preservation error. |
| Compatibility changes only as approved | `cargo metadata` resolves `rust-version 1.95` for all 19 packages; `cargo +1.95.0 check --workspace --all-targets` exits 0. The diff contains no edition, toolchain, dependency, or lockfile change. |
| Language evidence is honest | The Rust result is `degraded`, carrying 15 warning-bearing evidence records and 4 retained findings. Nothing was rewritten as a pass. Six warning-bearing compiler/test records are paired with a human-readable-format record that passes; both are retained and the cause (`ts-rs` dependency build artifacts) is named. |
| Product boundaries survive | No persistence, concurrency, serialization, retry, host/client authority, or public API contract changed. The two repairs that touch public types add `Debug` only where no protected data is reachable; every type whose `Debug` would render operator or provider content is a retained finding. `effigy qa` passes end to end, including `server:smoke` and the Longhorn consumer boundary check. |
| Instructions retain intent | Section-intent map in the closeout log. Every authority, stop, release, worktree, sibling-link, validation, papercut, and activation boundary is present after the rewrite; `CLAUDE.md` is byte-identical at `@AGENTS.md`; the marked `northstar:rust-quality` block hashes identically before and after. |
| Baseline is not laundered | The PR and closeout report `effigy doctor` as still degraded, name the untouched god-file and generated-in-source findings, and correct one opening-log baseline item against the observed worker environment rather than silently dropping it. |

## Runway

- `batch-cards/108-northstar-agents-rust-typescript-audit.md` — complete

