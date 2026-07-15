# 013 Shared Memory Contract

Status: draft
Owner: Tom
Updated: 2026-06-16

## Purpose

Define the planned shared memory boundary for Nucleus.

Shared memory is server-managed project context. It is not a dump of provider
memory, raw transcripts, terminal output, or private model state.

The goal is to let agent threads, humans, and steward personas preserve useful
facts, decisions, preferences, constraints, and summaries without binding the
project to one harness.

## Authority

The server owns shared memory records.

Harness-native memory may be imported, summarized, or linked only through an
explicit adapter or user action. It does not become authoritative Nucleus
memory by default.

Skills, agents, and adapters may propose memory records. A server-side policy
decides whether a proposal is accepted, queued for review, rejected, archived,
or projected to the management repository.

## Memory Scopes

Initial scopes:

- project
- task
- agent session
- repo membership
- workspace
- user-private

Project, task, repo, and accepted workspace memories may become shared project
state when sync policy allows it.

User-private memories must remain server-local unless a human explicitly
promotes them to shared project memory.

## Memory Kinds

Initial kinds:

- decision
- preference
- constraint
- architecture note
- project fact
- task context
- validation lesson
- risk
- open question
- conversation summary
- handoff summary
- research finding

Memory kind is a routing hint. It does not decide projection, visibility,
retention, or authority by itself.

## Memory Record

A memory record should include:

- stable memory id
- scope
- kind
- status
- title
- body or structured payload
- source refs
- confidence signal
- sensitivity class
- retention posture
- created actor
- created timestamp where known
- supersedes or superseded-by refs
- review state

Source refs may point to tasks, sessions, turns, documents, commits,
provider-neutral SCM changes, artifacts, accepted planning artifacts, or
accepted research synthesis artifacts.

Memory records must not use provider message ids, task ids, or document paths
as their durable identity.

## Status

Initial statuses:

- proposed
- accepted
- rejected
- stale
- superseded
- archived

Proposed memories are evidence. Accepted memories are shared working context.
Rejected, stale, superseded, and archived memories should remain auditable
until retention policy says otherwise.

## Sensitivity

Initial sensitivity classes:

- public project
- internal project
- user-private
- secret-adjacent
- restricted

Secret values, API keys, tokens, cookies, private keys, provider auth files,
raw credentials, and raw terminal streams must not be stored as memory.

Secret-adjacent memories may describe the existence, scope, or repair status
of secret-backed work through references and sanitized summaries only.

## Projection Rule

Accepted non-secret shared project memories may be projected into the
management repository when project sync policy allows it.

The first-pass projection root is:

```text
nucleus/memory/<memory-id>.toml
```

Projection records should be small and stable-id based. They should not copy
full provider transcripts, raw command output, raw terminal streams, or
private user notes.

User-private memories, restricted memories, raw conversation transcripts, and
provider-native memory stores remain server-local unless a future contract
defines an export path.

## Skill And Agent Boundary

A skill can help an agent emit structured memory proposals from a conversation.
That is only a proposal mechanism.

The server remains responsible for:

- assigning memory ids
- applying visibility and sensitivity policy
- deduping or superseding old memories
- deciding projection
- recording review state
- retaining source refs

Harness adapters should expose whether they have native memory features, but
Nucleus must not rely on those features for project memory continuity.

## Initial Product Panel

The first product-facing Memory panel is project-scoped and read-only.

- accepted memory and proposed memory remain visibly separate
- the panel consumes sanitized server summaries; it does not reconstruct
  titles, bodies, or source content absent from the read model
- accepted records may expose identity, scope, kind, lifecycle, sensitivity,
  retention, confidence, actor refs, and bounded source/link/evidence counts
- proposals may expose identity, scope, kind, review state, sensitivity,
  retention, and bounded reference counts
- empty, loading, unsupported, and error states remain explicit

The first panel does not accept, reject, edit, archive, supersede, project, or
extract memories. Those controls require a separate product-action lane over
the existing server admission and review boundaries.

## Out Of Scope

- vector database selection
- embedding model selection
- semantic search ranking
- automatic extraction policy
- provider-native memory sync
- raw transcript retention
- mutating UI for memory review
- memory projection migration format

## Research Gaps

- How much autonomous memory creation should be allowed per project.
- Whether memory extraction runs as a native steward persona, skill, adapter
  hook, or scheduler job.
- How accepted memories should be ranked against tasks and planning artifacts.
- Whether shared memory needs embeddings before the first useful UI.
