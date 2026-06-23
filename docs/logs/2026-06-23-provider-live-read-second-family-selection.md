# Provider Live Read Second Family Selection

Date: 2026-06-23

## Decision

Select status/check refresh as the second provider live-read family.

## Evidence

Local `gh` help was inspected without contacting a provider:

- `gh pr checks --help`
- `gh pr view --help`
- `gh issue view --help`
- `gh pr review --help`

Relevant bounded status/check fields from `gh pr checks --json`:

- `bucket`
- `completedAt`
- `description`
- `event`
- `link`
- `name`
- `startedAt`
- `state`
- `workflow`

`gh pr view --json statusCheckRollup` may also expose status/check evidence,
but the first stopped target should prefer `gh pr checks` because it is a
direct status/check command with a narrow field list.

## Rationale

Status/check refresh is the best next family because it advances:

- task completion evidence
- PR review readiness
- agent handoff quality
- merge-readiness inspection

It avoids reading issue bodies, comment bodies, review text, or mutable review
actions. It also matches an existing stopped provider-readiness family, so the
live-read proof extends a modeled surface rather than opening a new semantic
area.

## Approval Gate

The first live smoke for this family must stop at approval with:

- provider: GitHub CLI through server-owned command handoff
- command family: status/check refresh
- target: explicit public repository and pull request number or URL
- credential lease: named safe credential lease ref only, no credential
  material
- network authority: read-only GitHub status/check network authority ref
- payload policy: selected JSON fields only
- retention policy: no raw stdout/stderr, headers, request bodies, response
  bodies, auth material, or provider-native auth files
- expected command shape:
  `gh pr checks <number|url|branch> -R <owner/repo> --json bucket,completedAt,description,event,link,name,startedAt,state,workflow`

## Blocked

- provider writes
- review actions
- comments
- status/check creation or update
- task mutation
- callbacks
- interruption/recovery execution
- raw provider payload retention
