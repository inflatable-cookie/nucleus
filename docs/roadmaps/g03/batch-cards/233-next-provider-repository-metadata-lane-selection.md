# 233 Next Provider Repository Metadata Lane Selection

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../063-provider-auth-stopped-boundary-health-rebaseline.md`

## Purpose

Select the next bounded provider-auth lane after the stopped-boundary health
rebaseline.

## Acceptance Criteria

- [x] Next lane remains stopped by default.
- [x] Next lane advances provider auth without resolving credential material.
- [x] Next lane does not call provider networks.
- [x] Next lane is governed by contract `027`.

## Decision

Next lane:

- implement stopped provider repository metadata refresh/control records from
  provider context refs, without resolving credential material or calling
  provider networks

Reason:

- contract `027` names repository metadata refresh as an initial read family
- credential status refs are now modeled and persisted
- repository metadata is the next provider read surface needed before real
  forge execution can reconcile target provider state
