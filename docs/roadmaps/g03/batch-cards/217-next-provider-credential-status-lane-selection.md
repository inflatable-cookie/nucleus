# 217 Next Provider Credential Status Lane Selection

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../060-forge-network-stopped-runner-health-boundary-rebaseline.md`

## Purpose

Select the next bounded provider-auth lane after the forge network stopped
runner rebaseline.

## Acceptance Criteria

- [x] Next lane remains stopped by default.
- [x] Next lane advances provider auth without resolving credential material.
- [x] Next lane does not call provider networks.
- [x] Next lane is governed by contract `027`.

## Decision

Next lane:

- implement stopped provider credential-status refresh/control records from
  credential refs, without resolving credential material or calling provider
  networks

Reason:

- contract `027` names provider auth status refresh as an initial read family
- credential refs exist, but there is no separate stopped status-refresh
  record/control surface yet
- this keeps provider auth explicit before real credential resolution or
  provider execution
