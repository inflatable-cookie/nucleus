# 016 Effigy Project Integration Contract

Status: draft
Owner: Tom
Updated: 2026-06-16

## Purpose

Define how Effigy fits into Nucleus-managed projects.

Effigy should be optional per project. When a project opts in, Effigy becomes a
first-class workflow surface for task routing, validation planning, command
selection, project health, and native steward automation.

Nucleus must not require every project to use Effigy. It should make Effigy
feel native when present.

## Authority

The server owns the project integration record.

Effigy owns its manifest and task routing semantics. Nucleus observes,
summarizes, invokes, and links Effigy outputs through server command authority.

Agents and native personas may use Effigy only through explicit tool capability
policy. A bridged harness cannot be assumed to know how to run Effigy unless
the harness is extended, given a skill, or routed through a Nucleus-owned tool
surface.

## Project Opt-In

A project may declare Effigy support through:

- detected `effigy.toml`
- project integration config
- management repository projection
- user selection in the project settings UI

Opt-in state should include:

- enabled or disabled
- manifest path
- working directory policy
- available selector summary
- health status
- last doctor summary
- last task plan summary
- command authority requirements
- repair guidance

Nucleus should support projects without Effigy, projects with Effigy at the
management root, and multi-repo projects where Effigy selectors are scoped per
repo or per subsystem.

## First Selector Inventory Implementation

The first selector inventory surface is record-only.

It can represent:

- disabled Effigy
- detected, enabled, missing-manifest, or unknown Effigy state
- root project scope
- repo or subsystem scope
- sanitized manifest refs
- selector refs
- selector kinds
- command-scope hints
- sanitized evidence refs

Selector kinds include task, health, validation, setup, release gate, dev,
query, and custom values.

Command-scope hints include read-only, validation, management-state write,
source write, release, and unknown. These hints do not grant command
authority. They prepare later server policy checks.

The first implementation does not run Effigy, parse live command output, edit
manifests, execute selectors, or store raw command output.

## First Selector Refresh Command Implementation

The first selector refresh command surface is a sanitized summary of read-only
`effigy tasks` evidence.

It can represent:

- refreshed selector inventory
- no selectors
- blocked refresh
- unsupported refresh
- unknown refresh state

Selector refresh summaries may link to native tool action ids, runtime receipt
refs, sanitized evidence refs, scope, and selector records.

A refreshed summary can update the integration's selector inventory when the
summary and selector refs are sanitized. It must not execute selectors, edit
manifests, copy raw command output, or persist raw Effigy output into task
history.

## First Health And Validation Plan Implementation

The first health and validation-plan surface is record-only.

Health summaries can represent:

- ok
- warning
- error
- blocked
- unknown

Health summaries may link to native tool action ids, runtime receipt refs,
sanitized evidence refs, and repair hints.

Doctor command summaries wrap read-only `effigy doctor` evidence into health
summaries. They may represent summarized, blocked, unsupported, or unknown
doctor state. They must not mutate project state or copy raw doctor output.

Repair hints may describe missing manifests, missing selectors, doctor
warnings, doctor errors, unavailable plans, policy blocks, or custom project
conditions.

Validation-plan summaries can list planned selectors, selector purpose,
command-scope hints, evidence refs, and repair hints. A validation plan is not
proof that validation ran. Execution must be represented by a separate runtime
receipt or command evidence record.

Test-plan command summaries wrap read-only `effigy test --plan` evidence into
validation-plan summaries. They may summarize planned selectors, blocked
plans, unsupported plans, and unknown state. If a summary observes execution,
that state is out of scope for the plan summary and must be represented by a
separate execution receipt.

Durable health and validation-plan records must not copy raw Effigy output,
secrets, credentials, local cache paths, provider transcripts, or release
mutation evidence into task history.

## Agent Tooling Rule

Effigy access is a tool capability.

Agent threads may use Effigy when one of these is true:

- the harness has a native Effigy extension
- the harness has an installed Effigy skill
- the Nucleus server exposes an Effigy tool bridge
- a native persona invokes Effigy through server command authority

Tool access must preserve command policy. Effigy selectors that execute
commands still pass through server command authority, sandbox policy,
credential readiness, approval, and evidence retention.

## Native Steward Role

The native project steward should have deep Effigy knowledge.

When Effigy is enabled, the steward may:

- inspect available tasks and selectors
- run `effigy doctor` under read-only command policy
- run `effigy test --plan` to understand validation shape
- recommend validation selectors for tasks
- maintain task readiness hints from Effigy evidence
- detect missing or stale Effigy health signals
- summarize failures into task history proposals
- propose manifest or docs fixes

The steward must not silently mutate `effigy.toml`, task manifests, project
scripts, workflow files, or source files. It may propose changes or request
approval under the relevant command and sync policy.

## Task Integration

Tasks may reference Effigy selectors as intended validation, setup, health, or
release-gate commands.

Task records should keep:

- selector refs
- selector purpose
- last plan refs
- last execution evidence refs
- readiness blockers
- repair guidance

Selector refs are project workflow hints. They do not replace task acceptance
criteria or command authority.

## Projection Rule

Shared Effigy integration intent may be projected to the management repository
when project sync policy allows it.

Projected state should include stable integration config, selector references,
and non-secret health summaries. It must not include raw command output,
secrets, credentials, local cache paths, or provider transcripts.

## Out Of Scope

- Effigy manifest editing UI.
- Effigy plugin implementation.
- Harness-specific Effigy extensions.
- Automatic manifest rewrites.
- Command execution runtime.
- Release execution.
- CI workflow mutation.

## Research Gaps

- Whether the first integration uses a server-owned Effigy tool bridge, skills
  injected into bridged harnesses, or both.
- How multi-repo Effigy selector namespaces should appear in task assignment
  UI.
- Which Effigy outputs should be stored as summaries versus artifacts.
- How native personas should learn project-specific Effigy conventions.
