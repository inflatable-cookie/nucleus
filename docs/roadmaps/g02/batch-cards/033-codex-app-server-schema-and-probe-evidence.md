# 033 Codex App Server Schema And Probe Evidence

Status: completed
Owner: Tom
Updated: 2026-06-17
Milestone: `../011-codex-app-server-runtime-runway.md`

## Purpose

Verify current Codex app-server method and payload shape before implementing
against assumptions.

## Scope

- Inspect official Codex app-server docs.
- Inspect current local Codex CLI/app-server help where available.
- Prefer generated schema or local schema output if the installed runtime can
  provide it without starting a long-lived session.
- Compare evidence with T3 Code Codex adapter paths.
- Update the Codex runtime dossier with verified method names, ids, and gaps.

## Acceptance Criteria

- Codex dossier records current app-server evidence and retrieval/probe date.
- Any T3-only method assumptions are marked as needing schema proof.
- The next registry/lifecycle cards know which protocol facts are verified.
- No live project session or persistent provider state is created.

## Validation

- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if the installed Codex runtime cannot provide enough schema/probe
  evidence and official docs are insufficient.
- Stop if app-server behavior has changed enough to invalidate the selected
  first target.

## Outcome

Generated Codex app-server JSON schema and TypeScript bindings from local
`codex-cli 0.140.0` into `/tmp/nucleus-codex-app-server-schema`.

Updated `docs/research/specimen-dossiers/codex-runtime-boundary.md` with the
verified method subset, server request families, transport help, and
implementation cautions. No live project session was started and no generated
schema files were added to the repo.
