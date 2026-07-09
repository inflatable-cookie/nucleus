# 099 Selected Task Aggregate Control DTO

Status: completed
Owner: Tom
Updated: 2026-07-09
Milestone: `../020-selected-task-product-aggregate-query.md`

## Purpose

Expose the selected-task aggregate through the control API and DTO boundary.

## Work

- [x] Add query id and request DTO.
- [x] Add response DTO and conversions.
- [x] Add request/response tests.
- [x] Wire request handler query routing.

## Acceptance Criteria

- [x] Serialized control envelopes round-trip.
- [x] DTO shape stays read-only.
- [x] Existing proof queries remain available.

## Result

Added the selected-task product aggregate query to the control API, DTO codec,
response conversion, and request handler.
