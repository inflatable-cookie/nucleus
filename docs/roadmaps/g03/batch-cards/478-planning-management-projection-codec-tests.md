# 478 Planning Management Projection Codec Tests

Status: completed
Owner: Tom
Updated: 2026-06-24
Milestone: `../114-planning-management-projection-payloads.md`

## Purpose

Add deterministic encode/decode tests for planning projection payloads.

## Work

- [x] Test planning artifact projection round-trip.
- [x] Test planning task seed projection round-trip.
- [x] Test private/raw fields are not present in projected payloads.

## Acceptance Criteria

- [x] Round-trips preserve intended shared fields.
- [x] Raw transcripts, provider payloads, credential material, and private
  refs are absent.
