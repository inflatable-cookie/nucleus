# 026 Open-Ended Planning Conversation Contract

Status: draft
Owner: Tom
Updated: 2026-06-19

## Purpose

Define open-ended planning conversations as a first-class Nucleus workflow.

Most coding harnesses steer conversation toward implementation. Plan modes are
better, but they usually aim to produce a finite plan for a specific task.
Nucleus needs a separate mode for exploratory project thinking: asking
questions, testing assumptions, finding gaps, comparing directions, and pushing
the possible shape of a project before task creation begins.

## Vocabulary

Exploration session:

- open-ended conversation around a problem, project, product, system, or
  research area
- may be project-bound or standalone
- may produce questions, options, assumptions, risks, opportunities, research
  briefs, planning artifact drafts, and task seeds
- is not required to end in a plan

Finite plan:

- bounded plan for a known task or outcome
- may be generated from accepted exploration output
- should include steps, validation, stop conditions, and implementation scope

Task seed:

- provisional candidate task from an exploration or planning session
- not active execution work until promoted through the task domain

Accepted planning artifact:

- reviewed project backbone record promoted from exploration, guided planning,
  research, or operator input

Question backlog:

- unresolved questions preserved as first-class planning state
- may block promotion, launch research, or guide later conversation

Option map:

- structured set of possible directions, tradeoffs, constraints, and reasons
  for or against each option

## Mode Rule

Open-ended exploration is a mode, not a failed plan.

It must be distinct from:

- task execution
- finite plan mode
- autonomous goal loops
- deep research runs
- implementation review

The user may remain in exploration indefinitely. Nucleus must not force code,
tasks, roadmaps, or final decisions just to produce an output artifact.

## Conversation Rule

The exploration agent should:

- ask clarifying questions when the scope is underdefined
- probe hidden assumptions
- surface flaws and missing constraints
- offer materially different directions
- compare tradeoffs
- challenge weak ideas without shutting down creative exploration
- preserve open questions instead of smoothing over uncertainty
- identify when research, proof work, or task decomposition would be useful

The agent must not treat all project conversations as requests to write code.

## State Rule

An exploration session should eventually record:

- stable exploration session id
- optional project id
- title
- scope prompt
- conversation mode
- participants, harness refs, and persona refs
- source conversation refs
- question backlog
- assumption map
- option map
- risk and opportunity notes
- constraint notes
- research run refs
- memory proposal refs
- promoted planning artifact refs
- task seed refs
- decision refs
- status
- created and updated timestamps where known

Raw transcripts are source material. They are not the durable planning model by
themselves.

## Promotion Rule

Exploration output stays provisional until promoted.

Promotion can create or update:

- accepted planning artifacts
- research run briefs
- task seeds
- shared memory proposals
- decision records
- goal records
- roadmap branches

Promotion should be explicit and reviewable. Nucleus may suggest promotion, but
it must not silently convert brainstorm text into active tasks, accepted
architecture, durable memory, or SCM-projected files.

## Action Boundary

Exploration sessions do not require a next task.

A next task may be suggested only when there is an accepted pathway, such as a
promoted planning artifact, task seed, goal decomposition, research brief, or
operator instruction.

If the conversation exposes ambiguity, the correct next step may be another
question, an option comparison, or a research brief, not implementation work.

## Server Authority

The server owns exploration session records and promotion state.

Harness transcripts may be linked as evidence, but they are not the authority
for question status, accepted options, task seeds, memory proposals, or
promotion history.

Clients may render exploration as chat, whiteboard, planning board, outline,
or document review. The durable boundary remains server-owned structured state.

## Out Of Scope

- final UI design for exploration sessions
- prompt library format
- persona runtime implementation
- autonomous promotion policy
- model selection policy
- real-time collaborative editing semantics

## Research Gaps

- How much raw brainstorming history should be retained versus summarized.
- Whether exploration sessions should support branching conversations.
- How option maps should merge across multiple users.
- Which outputs should be projected to the management repository by default.
- How native steward personas should differ from bridged harness agents in
  exploration mode.
