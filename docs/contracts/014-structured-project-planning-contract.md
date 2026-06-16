# 014 Structured Project Planning Contract

Status: draft
Owner: Tom
Updated: 2026-06-16

## Purpose

Define the planned server-owned project planning system.

Nucleus should guide new and existing projects through structured definition:
vision, constraints, architecture, brainstorming, research questions, roadmap
shape, and task seed creation.

The system can mirror useful Northstar ideas, but it should become an
app-native planning model rather than only a docs folder convention.

## Authority

The server owns planning records.

Planning records may be projected to repository files for collaboration and
review. Projection is not the active planning database.

Northstar docs remain the current repo planning authority while Nucleus is
being built. Future Nucleus project planning may import, export, or generate
Northstar-shaped docs, but it must preserve structured server records as the
product boundary.

## Planning Session

A planning session records a guided planning pass.

It should include:

- stable planning session id
- project id
- session kind
- status
- prompt or template refs
- participants
- source refs
- output artifact refs
- task seed refs
- memory refs
- created and updated timestamps where known

Initial session kinds:

- project intake
- vision definition
- ideation
- architecture planning
- research planning
- deep research
- roadmap planning
- task breakdown
- decision review

## Planning Artifacts

Planning artifacts are structured project backbone records.

Initial artifact kinds:

- vision
- principles
- constraints
- architecture outline
- system inventory
- research question set
- research run brief
- research synthesis
- decision record
- roadmap outline
- milestone
- task seed group
- open question set

An artifact should include:

- stable artifact id
- project id
- artifact kind
- title
- body or structured payload
- status
- source planning session ref
- source research run refs
- source memory refs
- supersedes or superseded-by refs
- projection ref where available
- review state

## Status

Initial statuses:

- draft
- active
- accepted
- superseded
- archived

Draft planning output is not project authority. Accepted planning output may
guide task definition, memory ranking, workspace presets, and project
projection.

## Task Seed Rule

Planning can create task seeds. It must not silently create active tasks unless
policy and user intent allow it.

A task seed should include:

- title
- problem statement
- suggested action type
- suggested importance
- acceptance criteria draft
- context refs
- blocking questions
- agent-readiness hints

Promoting a task seed to a task is a task-domain action. The resulting task
gets its own stable task id.

## Deep Research Interface

Planning may launch or attach deep research runs.

Deep research is used when a planning question needs evidence beyond the
current project context: provider analysis, technical due diligence, domain
learning, architecture tradeoffs, market constraints, dependency evaluation, or
implementation discovery.

Planning records may link to:

- research run briefs
- research question sets
- source records
- accepted synthesis artifacts
- open evidence gaps
- task seeds produced from synthesis

Research output is not planning authority until accepted as a planning
artifact. Draft or active research remains evidence and should not silently
rewrite project vision, architecture, tasks, or shared memory.

## Projection Rule

Accepted shared planning artifacts may be projected to the management
repository when project sync policy allows it.

The first-pass projection root is:

```text
nucleus/planning/<artifact-id>.toml
```

Human-readable generated docs may also be projected later, but structured
records are the durable sync surface.

Projection must not include private brainstorming, raw transcripts,
unreviewed model output, secrets, or restricted memories by default.

## UI Direction

The first UI should be a guided project planning flow, not a blank document
editor.

Expected surfaces:

- project intake wizard
- artifact review and acceptance
- task seed review
- planning history
- links between planning artifacts, tasks, memories, docs, and SCM work

Implementation is deferred until the storage and server API boundaries exist.

## Out Of Scope

- final UI layout
- prompt library format
- template/plugin system implementation
- LLM orchestration policy
- deep research crawler or browser automation implementation
- automatic roadmap generation without review
- Northstar export format
- planning artifact merge policy

## Research Gaps

- Whether planning templates are Rust-side records, client-side plugins, or
  server-loaded packages.
- How app-native planning should map to Northstar docs for projects that use
  both.
- How much brainstorming history should be retained versus summarized.
- How multi-user planning edits resolve through SCM projection.
- How guided planning should launch, pause, resume, and accept deep research
  runs.
