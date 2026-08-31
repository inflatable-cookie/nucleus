# Northstar Instruction And Language Quality Audit Opened

Date: 2026-08-31
Roadmap: `../roadmaps/g05/026-northstar-instruction-and-language-quality-audit.md`
Card: `../roadmaps/g05/batch-cards/108-northstar-agents-rust-typescript-audit.md`

## Decision

Open one independent g05 maintenance lane for the Nucleus AGENTS surface and
both implementation languages. One worker will run the repository-scope Rust
and desktop TypeScript/Svelte recorders, apply only authorized repairs, optimize
the applicable instruction chain, and open one PR for orchestrator review.

The operator set Rust 1.95 as Nucleus's MSRV. This matches Longhorn's committed
dependency floor. The lane may install the missing language-quality activation
and policy files and make every workspace package inherit 1.95; no other
version-policy choice is implied.

## Discovery

- clean planning checkout at `1e23d376`
- 19 Cargo workspace packages
- 431 TypeScript/Svelte files under `apps/desktop`
- Svelte 5.56.8; no SvelteKit package evidence
- `CLAUDE.md` already equals `@AGENTS.md`
- target instruction checker: 69 non-blank lines, about 864 tokens, five
  placement leads, three procedure leads, two freshness leads
- no active Nucleus Paseo orchestrator or worker

## Baseline Limitations

`effigy doctor` reports two errors and two warnings before this lane:

- local Poodle Bun registrations without a desired link ledger
- 293 god-file findings, 13 at error severity
- 302 generated-in-source warnings, dominated by generated desktop bindings
- stale graph index

These are recorded baselines. Card 108 does not authorize broad structural
repair or local package-registration mutation.

## Dispatch Shape

One high-reasoning worker owns the combined audit because findings can cross
Rust-generated DTOs, TypeScript consumers, and always-loaded instructions. The
worker needs the primary Longhorn checkout available as `../longhorn` beside
its Paseo worktree. It must not merge; the orchestrator reviews the exact PR
head, returns requested changes to that same worker, and merges accepted checked
work without another approval prompt.

