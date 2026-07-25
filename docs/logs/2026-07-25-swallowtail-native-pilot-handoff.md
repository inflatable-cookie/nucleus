# Swallowtail Native Pilot Handoff

Date: 2026-07-25
Provider effects: none

## Outcome

Nucleus card 010 freezes one exact native pilot envelope. The handoff stops
before authenticated catalogue discovery and before the first model turn.

## Exact Tuple

| Surface | Fixed value |
| --- | --- |
| Nucleus runtime source | `2a6d72a8d3326cc70c6852f8fa86ff7f8ca995f2` |
| Swallowtail pre-handoff checkpoint | `ea22603d5fc50545b0ef477187b3ab83a8ab785c` |
| Swallowtail runtime-code source | `e9ead4d35fb7754962053417bf8328e646839b32` |
| Codex executable | host-approved direct `codex` target; SHA-256 `1da3f4e0e96028b8a771814293c3033dafd1971f943f6c7e79b0897fe705f590` |
| Codex version | `codex-cli 0.145.0` |
| Compatibility | qualified, maintained, latest-qualified; `codex.app-server.v2.workspace-roots` behavior |
| Operation and transport | interactive session; Codex app-server v2 over local stdio |
| Host and topology | macOS `26.5.2`, arm64, local authoritative host |
| Harness configuration | explicit ambient agreement |
| Access | ChatGPT login; interactive OAuth; subscription allowance; `codex` audience; provider-supported |
| Session access | Swallowtail read-only profile |
| Model route | exact `gpt-5.4-mini`, low reasoning, no fallback |
| State root | `/tmp/nucleus-swallowtail-pilot-20260725/state-root` |
| Fixture | `/tmp/nucleus-swallowtail-pilot-20260725/fixture-repository` at `04f7eb371e4e3ac0010a69d3f96052a7becbe43a` |

The executable locator is deliberately not retained as an absolute user path.
The pre-launch probe must resolve the same direct target, version, and hash.
Any drift stops the pilot.

The state root is empty and writable. The fixture contains only `README.md`
and `STATUS.md`, has no private material, and is filesystem read-only. The
proof profile binds fresh seeded Nucleus records to that fixture. No normal
Nucleus state or source repository is selected.

## Access Gate

`codex login status` reports ChatGPT. `CODEX_API_KEY`,
`CODEX_ACCESS_TOKEN`, and `OPENAI_API_KEY` are absent from the launch shell.
No public API-key or separately metered route is authorized.

Earlier Nucleus evidence proves authenticated catalogue operation through
Swallowtail, but this handoff does not claim a current exact
`gpt-5.4-mini` observation. The first approved catalogue attempt must report
that exact route. Absence, audience drift, or separately metered billing stops
the pilot with zero turns.

## Workload

The pilot permits 3 catalogue operations and 12 planned Agent Chat turns:

1. Launch one uses a 180,000 ms turn deadline: 4 ordinary successes, 1
   read-only callback success, and 1 operator cancellation across 2
   conversations.
2. Launch two follows one full restart and uses a 180,000 ms deadline: 2
   ordinary successes and 2 read-only callback successes across 3 opened or
   reopened sessions.
3. Launch three follows the second full restart and uses a 30,000 ms deadline:
   1 post-restart recovery success, then 1 controlled deadline using a
   read-only action known to exceed that bound.

Callbacks use only `task_ledger` or `task_workflow` inspection against seeded
fixture records. The cancellation scenario uses a long-running read-only
action and the normal Agent Chat Cancel control.

At most 3 failed-scenario reruns are allowed: 15 turn attempts total, 6
provider-thread lifecycles total, 3 live app-server children, one active turn,
and 60 minutes wall time. No task, workspace, SCM, forge, proposal,
provider-account, fixture, or Git mutation is authorized.

## Evidence And Stops

Stable evidence may retain the exact tuple, scenario and operation class,
terminal class, counts, elapsed time, sanitized diagnostics, cleanup truth,
and provider-supplied usage or rate summaries. It excludes prompts, output,
raw payloads, raw provider ids, credentials, and absolute user paths.

Stop on secret or raw-payload retention, unexpected writes, unjoined
children, terminal-state mismatch, source or executable drift, model or
audience drift, unexplained provider state, rate or spend uncertainty, or the
60-minute and 15-turn ceilings.

## Validation

- focused project-seed, desktop-profile, and proof-fixture tests pass
- the full desktop Rust library passes 56 tests
- desktop checking reports zero errors
- all 20 desktop client tests pass
- Nucleus documentation and Northstar checks pass
- `git diff --check` passes

## Remaining Gate

The operator must explicitly approve this ChatGPT-backed 15-turn,
60-minute envelope before Swallowtail card 041 starts. That approval does not
authorize workspace writes, a public API route, publication, push, tag, or
release.
