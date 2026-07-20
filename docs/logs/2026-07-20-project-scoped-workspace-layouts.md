# Project-Scoped Workspace Layouts

Date: 2026-07-20

## Outcome

Workspace panel composition is project-scoped. Switching projects loads that
project's open panels, tab order, active tab ids, panel resource targets, and
four split ratios. Native window geometry and project-rail width remain global.

## Persistence

Schema v7 stores one host-owned window placement record and a map of project
layouts keyed by exact project id. A schema 1-6 layout becomes a one-time
migration candidate claimed by the first project loaded after upgrade. Other
unseen projects receive one Agent Chat panel in `centerTop`.

Every renderer load and save carries a project id. Debounced resize writes
capture that id, and late loads or saves cannot replace the currently selected
project's view. Region rendering also verifies that the loaded config belongs
to the selected project. A project-id key recreates the panel subtree on every
switch, while active-panel lookup supplies a non-null empty sentinel during
teardown rather than exposing a disappearing live snippet argument.

## Evidence

- 17 focused native workspace tests pass, including schema 1-6 migration,
  project isolation, active tabs, minimal defaults, and host geometry guards.
- Desktop type checks and 18 focused client tests pass.
- The running schema-v7 store contains two independent project layouts: the
  migrated layout retains six panels and the second layout contains one panel.

## Remaining Gate

Confirm native switching between two visibly different layouts and the
Agent Chat-only shape of a new project.
