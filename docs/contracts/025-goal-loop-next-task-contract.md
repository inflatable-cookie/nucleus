# 025 Goal Loop And Next Task Contract

Status: draft
Owner: Tom
Updated: 2026-06-19

## Purpose

Define the difference between goals, tasks, loops, and next-task selection.

Nucleus should not produce a next task as a ritual placeholder. A next task is
valid only when it follows from an accepted pathway: planning artifacts,
roadmaps, task state, goals, constraints, and current evidence.

## Vocabulary

Goal:

- conceptual desired outcome
- may span many tasks
- may be exploratory or long lived
- can be active before actionable work is fully decomposed

Task:

- durable actionable unit
- has title, description, acceptance criteria, importance, assignment state,
  activity state, and evidence refs
- may produce one or more work items

Work item:

- execution unit for one task
- can be delegated, run, reviewed, retried, abandoned, or accepted
- does not complete the parent task by provider completion alone

Loop:

- runtime process that advances a goal, task, or work item until a stop
  condition is reached
- may involve a bridged harness, native steward, private helper, or visible
  fork

Next task:

- the next actionable step from a known pathway
- must be backed by roadmap, task, goal, planning artifact, or explicit
  operator instruction

## Goal Rule

A goal record should include:

- stable goal id
- project id when applicable
- owner or actor refs
- desired outcome
- scope
- current status
- related task refs
- related planning artifact refs
- stop conditions
- evidence refs
- current next task ref or next action statement

Goals may guide task creation, task ordering, loop continuation, and steward
suggestions. Goals do not replace tasks.

## Loop Rule

A loop must have explicit state:

- loop id
- goal id or task/work item ref
- active harness/native agent refs
- permitted tool families
- current step
- stop conditions
- retry/failure budget
- validation requirements
- evidence gathered
- last useful result
- next action
- escalation conditions

Loop continuation must be evidence-driven. It must stop or escalate when:

- acceptance criteria are met
- required authority is missing
- validation fails and repair is not admitted
- the loop repeats without progress
- tool or provider limits are reached
- user input is required
- policy blocks the next action

## Next Task Rule

The next task pointer must come from a pathway.

Allowed sources:

- active roadmap ready card
- active project task priority queue
- goal decomposition
- accepted planning artifact
- task work item recovery state
- validation failure repair path
- operator instruction

Forbidden sources:

- generic encouragement
- arbitrary model guess
- stale roadmap item
- completed task without a follow-on record
- hidden helper recommendation without surfaced evidence

When the pathway is missing, Nucleus should say the next task is blocked by
planning ambiguity rather than inventing work.

## Pathway Record Rule

Pathways should preserve enough context to explain why the next task is next.

A pathway record should eventually include:

- pathway id
- source type
- source ref
- ordered steps or candidate branches
- current position
- completed refs
- blocked refs
- rationale refs
- last validation refs
- next task ref or next action

Roadmaps are one pathway implementation. Project planning sessions, research
runs, task queues, and loop state are other pathway sources.

## Proactive Steering Rule

Nucleus may steer conversations when the active work drifts from the pathway.

Steering may:

- remind the agent of the current goal
- surface the next task
- warn about missing validation
- ask for operator input
- propose a new task
- recommend splitting work
- recommend a visible work fork
- stop a loop that is repeating without progress

Steering must include a reason and evidence refs where available. It must not
pretend to be provider-native model reasoning.

## Task And Goal Relationship

One goal may own many tasks. One task may serve many goals only through explicit
refs.

Tasks remain the unit for assignment, evidence, acceptance criteria, and work
items. Goals remain the unit for direction and continuity.

If a user defines a goal that is immediately actionable, Nucleus may create or
suggest a task. If a task reveals a broader desired outcome, Nucleus may create
or suggest a goal.

## Out Of Scope

- Implementing autonomous loops.
- Implementing goal records in code.
- Building UI for pathway visualization.
- Replacing Northstar roadmaps.
- Allowing hidden agents to mutate project state.

## Research Gaps

- How much of Codex `/goal` behavior should influence Nucleus loop records.
- Which harnesses expose enough lifecycle control for reliable loop
  continuation.
- How much loop state should be visible in the UI by default.
- How steward personas should propose next tasks without becoming noisy.
