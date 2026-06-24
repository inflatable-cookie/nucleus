# 475 Planning Management Projection Payload Selection

Status: completed
Owner: Tom
Updated: 2026-06-24
Milestone: `../114-planning-management-projection-payloads.md`

## Purpose

Select the first concrete management projection payload shape for planning
artifacts and planning task seeds.

## Work

- [x] Audit current management projection payload types.
- [x] Map planning artifact fields to projection payload fields.
- [x] Map task seed fields to projection payload fields.
- [x] Identify fields that must stay server-local or private.

## Acceptance Criteria

- [x] The selected shape follows `planning-management-projection-shape.md`.
- [x] Task seeds remain planning records, not task records.
- [x] Next implementation card has bounded type changes.
