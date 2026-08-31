# Nucleus Agents

Scope: whole repository.

Nucleus is an AI-powered development environment: a portable Rust engine that
owns durable project, task, and evidence records, wrapped by a local server host
and a Tauri desktop client. Docs and contracts land before behavior.

Four properties must survive a change here.

- The server owns durable state. Clients render and request; they never become
  the authority for a project, task, or receipt.
- The engine stays portable. Desktop, server, and CLI hosts consume the same
  crates, so nothing Tauri-specific belongs in the engine.
- Credential material never enters durable state, logs, or `Debug` output.
  Records carry refs and presence flags, not secrets.
- Generated output is generator-owned. `apps/desktop/src/lib/control/generated/`
  is ts-rs output from the `nucleus-server` DTOs; regenerate it with
  `effigy desktop:bindings` instead of editing it.

## Always-loaded boundaries

- Use the repository's canonical docs and ready-card surfaces; do not invent a
  parallel planning authority. When planning authority does not settle the next
  direction, stop and ask, and keep continuation inside the current bounded
  lane.
- Normal-mode agents work in the current checkout against the task's canonical
  docs. Worker mode is active only when an orchestrator-dispatched handoff
  declares it. That handoff is named by an absolute path that includes its
  owning repo, and the handoff — not a branch, directory, or harness — carries
  the execution contract. Never resolve a sibling repo's handoff as a relative
  file under this checkout. Rules:
  `docs/contracts/034-agent-instruction-surface-contract.md`.
- Do not implement server, Tauri, or harness behavior before the relevant
  contracts are clear enough to test.
- Do not run release mutations or change CI or workflow files without an
  explicit request.
- This checkout's parent directory must contain `longhorn` resolving to the
  primary Longhorn checkout (for example `/Users/tom/Dev/projects/longhorn`).
  The `apps/desktop/src-tauri` Cargo path dependencies and the `apps/desktop`
  Bun `file:` dependencies both reach Longhorn that way, so a missing sibling
  fails the desktop build outright. Create the link when it is absent; reuse
  only a link that already resolves to that checkout; stop on any other
  existing path and never overwrite one. Do not replace those path
  dependencies with a git pin. Manual worktree locations come from
  `docs/contracts/035-agent-local-paths-contract.md`.

## Common commands

```sh
effigy tasks
effigy doctor       # only when routing or environment state is uncertain
effigy test --plan
effigy qa           # full board; the gate for calling work done
effigy qa:docs
```

Prefer `effigy <task>` for supported repo work before falling back to raw
tools. Do not add `package.json` scripts that re-export Effigy tasks.

`effigy doctor` is degraded at baseline, mostly from god-file and
generated-in-source scan findings. That is known background, not authority to
widen a lane.

## Docs authority

Each front door indexes the rest.

- `docs/README.md`
- `docs/vision/README.md`
- `docs/architecture/README.md`
- `docs/contracts/README.md`
- `docs/specs/README.md`
- `docs/roadmaps/README.md`
- `docs/logs/README.md`
- `docs/contracts/001-working-rules.md` — how work is executed and closed
- `docs/contracts/034-agent-instruction-surface-contract.md` — continuation,
  batch size, planning ambiguity, reporting, worker mode, papercuts
- `docs/contracts/035-agent-local-paths-contract.md` — local path registry

Nucleus is in strict Northstar posture, so those doc kinds are not
interchangeable: specs are provisional planning surfaces, architecture records
realized structure, contracts hold durable rules and boundaries, roadmaps
sequence work, and logs record meaningful decisions and evidence.

During execution, record a small recurring solvable hurdle in `PAPERCUTS.md`
according to the working-rules contract; do not turn that observation into
unplanned work.

## Rust code shape

Keep Rust code in small, focused modules. `nucleus-server` alone is over a
thousand files and stays navigable only because of this.

- use `lib.rs` as the crate front door and module index
- split domain types, traits, adapters, and runtime logic into named files
- avoid large catch-all modules unless a crate is still only a placeholder
- prefer clear module boundaries over dumping unrelated types into one file

## Read on demand

Nested `AGENTS.md` files carry path-specific rules, contracts carry durable
boundaries, guides carry procedures, and skills carry task-specific workflows.
Writing style lives in `docs/policy/internal-writing-style.md`.

<!-- northstar:rust-quality:start -->
## Northstar Rust Quality

Scope: Rust source, Cargo manifests, build files, tests, and directly related
documentation under this directory.

Use Northstar's strict everyday-authoring route for ordinary Rust work. Resolve
the repository-owned profile and deviations under `docs/contracts/`; never
assume a universal MSRV. Re-enter at task start and coherent batch closeout.
Preserve unrelated work. A quality audit, no-slop pass, or audit-and-fix request
is explicit audit intent; never route it through everyday authoring.
<!-- northstar:rust-quality:end -->
