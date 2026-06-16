# 015 Deep Research Contract

Status: draft
Owner: Tom
Updated: 2026-06-16

## Purpose

Define the planned deep research system.

Deep research is a server-owned work surface for building durable
understanding on a subject. It can support project planning, task preparation,
architecture decisions, market or provider analysis, technical due diligence,
or a standalone research endeavour.

The output should be structured evidence and synthesis, not just a long chat
transcript.

## Authority

The server owns research records.

Research agents, harness adapters, skills, browser tools, and humans may
contribute observations, sources, notes, and draft synthesis. The server owns
research ids, source records, evidence classification, review state,
projection, and links to planning, tasks, memories, and artifacts.

Deep research may use external web access, local repos, docs, PDFs, issue
trackers, package registries, model outputs, and uploaded materials, but raw
source material does not become trusted project knowledge until classified and
reviewed.

## Research Run

A research run records one bounded investigation.

It should include:

- stable research run id
- optional project id
- title
- research brief
- status
- scope boundary
- research questions
- source plan
- source records
- observation refs
- synthesis artifact refs
- confidence and coverage summary
- memory proposal refs
- planning artifact refs
- task seed refs
- created and updated timestamps where known

A research run can be project-bound or standalone. Standalone runs may later
be attached to a project, planning session, task, or memory record.

## Research Questions

Research questions are first-class records.

They should include:

- stable question id
- research run id
- question text
- priority
- status
- source requirements
- answer summary
- evidence refs
- open gaps

Questions should be decomposable so agents can work in parallel without losing
the shape of the investigation.

## Source Records

Source records preserve provenance.

They should include:

- stable source id
- source kind
- locator
- access time where known
- author or publisher where known
- publication or update time where known
- retrieval method
- reliability posture
- licensing or quoting limits where relevant
- artifact refs for retained copies where policy allows it

Initial source kinds:

- web page
- official docs
- source repository
- code file
- issue or discussion
- paper
- PDF
- package registry
- local file
- interview or human note
- model-generated lead
- custom

Model-generated leads are not evidence until traced to source records or
accepted as speculation.

## Observations And Synthesis

Observations are extracted claims, facts, comparisons, or findings tied to
source refs.

A synthesis artifact combines observations into an answer, recommendation,
decision support note, planning input, or task seed group.

Synthesis should preserve:

- source coverage
- confidence
- contested or uncertain claims
- dated assumptions
- remaining gaps
- follow-up questions
- promotion targets

Deep research must distinguish evidence, inference, speculation, and
recommendation.

## Status

Initial research run statuses:

- proposed
- active
- paused
- blocked
- synthesized
- accepted
- superseded
- archived

Accepted research can feed planning artifacts, shared memories, architecture
docs, task seeds, model-routing decisions, adapter choices, or project
guardrails.

## Projection Rule

Accepted non-private research outputs may be projected to the management
repository when project sync policy allows it.

The first-pass projection root is:

```text
nucleus/research/<research-run-id>.toml
```

Projection should retain structured research metadata, questions, source refs,
and accepted synthesis. It should not copy raw browser caches, copyrighted
source payloads, private notes, secret-bearing files, raw transcripts, or
unreviewed model output by default.

## Planning And Memory Interface

Deep research can create:

- planning artifact proposals
- task seed proposals
- shared memory proposals
- decision support notes
- source dossiers
- evidence indexes

Promotion is explicit. A research finding does not become accepted project
planning, task context, or shared memory until the target domain accepts it.

## Out Of Scope

- crawler implementation
- browser automation policy
- search provider selection
- vector index implementation
- citation renderer
- copyright-retention policy
- UI for research review
- automatic promotion without review

## Research Gaps

- How autonomous long-running research should be scheduled and budgeted.
- How source reliability scoring should work across official docs, code,
  issues, papers, and model-generated leads.
- Whether deep research shares a crate with planning or gets a dedicated
  `nucleus-research` crate.
- How accepted research should be projected into Northstar-style docs.
