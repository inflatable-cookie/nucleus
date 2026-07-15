# 189 Project Control Validation

Status: completed
Owner: Codex
Updated: 2026-07-15
Milestone: `../038-project-control-workflow.md`
Auto-start next card: no

## Objective

Validate empty durable project creation, lifecycle transitions, restart
continuity, and compact rail behavior.

## Acceptance

- command, persistence, desktop, and docs checks pass
- an empty project can use chat, tasks, goals, and memory where filesystem is
  not required
- an empty project terminal starts in the authoritative host's safe default
  directory without creating a project resource
- destructive actions give truthful impact and refusal feedback
- parked and archived projects leave the working rail but remain manageable
  through all, parked, and archived views
- operator confirms the rail remains visually simple

## Outcome

Name-only creation, active-only rail behavior, parked and archived management,
restart persistence, guarded deletion, and resource-free project operation are
validated. Resource-free terminals now use the authoritative host user's home
without inventing a project resource.
