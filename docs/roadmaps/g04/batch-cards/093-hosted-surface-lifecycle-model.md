# 093 Hosted Surface Lifecycle Model

Status: completed
Owner: Tom
Updated: 2026-07-07
Milestone: `../019-workspace-hosting-model-extraction.md`

## Purpose

Model hosted surfaces as window-owned top-level work surfaces, distinct from
panel tabs.

## Work

- [x] Add hosted surface records with stable ids, kind, label, host window,
  lifecycle state, and attachment refs.
- [x] Add window-scoped surface ordering and active-surface state.
- [x] Add pure fallback helper for closing or losing an active surface.
- [x] Keep server-managed resource refs as refs only.
- [x] Add tests for active fallback, reorder, missing active surface, and empty
  window behavior.

## Acceptance Criteria

- [x] Surfaces are hosted by windows, not by project panel records alone.
- [x] Active-surface fallback is deterministic and local-profile owned.
- [x] Terminal/browser/editor/SCM resources are only attachment refs.

## Result

Added `hosted_surfaces.rs` with:

- `HostedSurface`
- `HostedSurfaceLifecycleState`
- `SurfaceAttachmentRef`
- `SurfaceAttachmentKind`
- `WindowHostedSurfaces`
- `HostedSurfaceLifecycleError`
- `normalize_active_surface`
- `close_hosted_surface`
- `reorder_hosted_surfaces`

The module keeps hosted-surface order and active-surface state window-scoped.
Attachment refs identify server-managed resources but do not grant authority
or own the attached process/state.

## Validation

- `cargo fmt --all`
- `cargo test -p nucleus-workspaces`
- `cargo check -p nucleus-workspaces`
