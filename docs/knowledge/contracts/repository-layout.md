# Repository layout

| Path | What belongs here |
| --- | --- |
| `engine/crates/` | The Rust service, engine and CLI. The [architecture map](../architecture.md) gives each crate’s responsibility. |
| `client/` | The TypeScript browser board, task and planning views, and Settings. `client/web/engine-index.tsx` is the shipped entrypoint. |
| `shared/` and `hosts/` | Types, pure view logic, theme conversion and host vocabulary used by the board or tooling. Native host operations live in Rust. |
| `skills/nucleus/` | Instructions for planners, workers and reviewers. Keep the role protocol aligned with the service's prompt builder. |
| `test/` | TypeScript fixtures and tests. `scripts/active-tests.json` lists the active suite. Rust tests live alongside their crates. |
| `scripts/` and `effigy.toml` | Board builds, repository checks and test selectors. |
| `docs/knowledge/` | Contracts, specs and operations. The plan and task state live in Nucleus. |
| `changelog.d/` | One user-facing fragment per pull request. |

Build the board with `effigy engine:board-build -- <output-dir>`. To verify a
change in imports, inspect the inputs of that shipped entrypoint. Use
`effigy check` for TypeScript and publication and the committed
`effigy test:affected --run` for its affected tests.

## Import and compatibility rules

Shared browser modules depend on other shared modules and browser-safe
libraries. Board screens use their shell interface. The engine board entry
selects the web shell and uses the retained host vocabulary, profile and theme
readers. Keep the native host client and controller credentials in Rust.

When moving code, preserve method shapes, task identity, callback authentication,
frozen delivery intent and UI behaviour. Update affected paths, entrypoints and
instructions together. Run the publication check on tracked sources. Private
task evidence, runtime state, credentials and local paths stay outside Git.

The last unified pre-retirement source is available at `737246d22`, for
example `git show 737246d22:core/engine.ts`. The
[historical layout](https://github.com/inflatable-cookie/nucleus/blob/737246d22/docs/knowledge/contracts/repository-layout.md)
describes that tree.
