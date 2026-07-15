# 193 Multi-Resource Workflow Validation

Status: in progress
Owner: Codex
Updated: 2026-07-15
Milestone: `../039-multi-resource-attachment-and-targeting.md`
Auto-start next card: no

## Objective

Validate attachment, movement repair, defaults, explicit targeting, and panel
behavior across zero, one, and many local or remote resources.

## Acceptance

- [x] focused Rust, desktop, persistence, and docs checks pass
- [x] editor, terminal, browser, diff, and agent chat target the expected resource
- [x] project state survives a missing or moved resource
- [ ] operator confirms the common one-resource workflow stays quiet

## Validation Evidence

- zero and one healthy working resources keep panel resource controls hidden;
  multiple or repair-required resources expose the compact control
- explicit resource ids override project defaults for editor and terminal;
  resolver coverage proves configured defaults, ambiguity, reference-resource
  exclusion, repair failure, and remote authority propagation
- panel resource choices survive workspace-config serialization per project
- failed wrong-kind repair preserves project revision, project id, resource id,
  and locator; successful moved-resource repair retains locator history
- browser navigation remains resource-free by design; diff reads retain the
  immutable resource attribution captured by their review snapshots
- resource-free project copy now states the current boundary truthfully: Tasks
  and Terminal work, while file-backed actions need an attached resource

## Operator Check

With a normal project containing one healthy working resource, open Agent
Chat, Editor, and Terminal. None should show a resource selector or repair bar.
