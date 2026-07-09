//! Window-hosted surface records and lifecycle helpers.

use crate::ids::{SurfaceId, WindowId};
use crate::surfaces::SurfaceKind;

/// Top-level work surface hosted inside a workspace window.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HostedSurface {
    pub id: SurfaceId,
    pub kind: SurfaceKind,
    pub label: String,
    pub host_window_id: WindowId,
    pub lifecycle_state: HostedSurfaceLifecycleState,
    pub attachment_refs: Vec<SurfaceAttachmentRef>,
}

/// Lifecycle state for a hosted surface.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HostedSurfaceLifecycleState {
    Open,
    Detached,
    Missing { reason: String },
    Closing,
}

/// Server-managed resource ref attached to a hosted surface.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SurfaceAttachmentRef {
    pub kind: SurfaceAttachmentKind,
    pub resource_id: String,
}

/// Resource family for an attachment ref. The ref does not grant authority.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SurfaceAttachmentKind {
    AgentSession,
    Terminal,
    Browser,
    EditorBuffer,
    ScmState,
    RuntimeEvidence,
    Task,
    Other(String),
}

/// Window-scoped hosted surface order and active-surface state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WindowHostedSurfaces {
    pub window_id: WindowId,
    pub surface_ids: Vec<SurfaceId>,
    pub active_surface_id: Option<SurfaceId>,
}

/// Error returned by pure hosted-surface lifecycle helpers.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HostedSurfaceLifecycleError {
    UnknownSurface { surface_id: SurfaceId },
    LastSurfaceInWindow { surface_id: SurfaceId },
    ReorderMismatch,
}

/// Normalize active-surface state for a window.
pub fn normalize_active_surface(mut window: WindowHostedSurfaces) -> WindowHostedSurfaces {
    window.active_surface_id = window
        .active_surface_id
        .filter(|surface_id| window.surface_ids.contains(surface_id))
        .or_else(|| window.surface_ids.first().cloned());
    window
}

/// Close a hosted surface and choose the previous surface as active fallback.
pub fn close_hosted_surface(
    window: &WindowHostedSurfaces,
    surface_id: &SurfaceId,
) -> Result<WindowHostedSurfaces, HostedSurfaceLifecycleError> {
    let removed_index = window
        .surface_ids
        .iter()
        .position(|candidate| candidate == surface_id)
        .ok_or_else(|| HostedSurfaceLifecycleError::UnknownSurface {
            surface_id: surface_id.clone(),
        })?;

    if window.surface_ids.len() <= 1 {
        return Err(HostedSurfaceLifecycleError::LastSurfaceInWindow {
            surface_id: surface_id.clone(),
        });
    }

    let mut next = window.clone();
    next.surface_ids.retain(|candidate| candidate != surface_id);

    if window.active_surface_id.as_ref() == Some(surface_id) {
        let fallback_index = removed_index.saturating_sub(1);
        next.active_surface_id = next
            .surface_ids
            .get(fallback_index)
            .cloned()
            .or_else(|| next.surface_ids.first().cloned());
    }

    Ok(normalize_active_surface(next))
}

/// Reorder hosted surfaces without adding or removing ids.
pub fn reorder_hosted_surfaces(
    window: &WindowHostedSurfaces,
    ordered_surface_ids: Vec<SurfaceId>,
) -> Result<WindowHostedSurfaces, HostedSurfaceLifecycleError> {
    let mut current = window.surface_ids.clone();
    current.sort();

    let mut next = ordered_surface_ids.clone();
    next.sort();

    if current != next {
        return Err(HostedSurfaceLifecycleError::ReorderMismatch);
    }

    Ok(normalize_active_surface(WindowHostedSurfaces {
        window_id: window.window_id.clone(),
        surface_ids: ordered_surface_ids,
        active_surface_id: window.active_surface_id.clone(),
    }))
}

#[cfg(test)]
mod tests {
    use super::{
        close_hosted_surface, normalize_active_surface, reorder_hosted_surfaces,
        HostedSurfaceLifecycleError, WindowHostedSurfaces,
    };
    use crate::ids::{SurfaceId, WindowId};

    fn surface(id: &str) -> SurfaceId {
        SurfaceId(id.to_string())
    }

    fn window(
        surface_ids: Vec<SurfaceId>,
        active_surface_id: Option<SurfaceId>,
    ) -> WindowHostedSurfaces {
        WindowHostedSurfaces {
            window_id: WindowId("window:primary".to_string()),
            surface_ids,
            active_surface_id,
        }
    }

    #[test]
    fn close_active_surface_falls_back_to_previous_surface() {
        let closed = close_hosted_surface(
            &window(
                vec![
                    surface("surface:1"),
                    surface("surface:2"),
                    surface("surface:3"),
                ],
                Some(surface("surface:2")),
            ),
            &surface("surface:2"),
        )
        .expect("active surface should close");

        assert_eq!(
            closed.surface_ids,
            vec![surface("surface:1"), surface("surface:3")]
        );
        assert_eq!(closed.active_surface_id, Some(surface("surface:1")));
    }

    #[test]
    fn close_inactive_surface_preserves_active_surface() {
        let closed = close_hosted_surface(
            &window(
                vec![
                    surface("surface:1"),
                    surface("surface:2"),
                    surface("surface:3"),
                ],
                Some(surface("surface:3")),
            ),
            &surface("surface:1"),
        )
        .expect("inactive surface should close");

        assert_eq!(closed.active_surface_id, Some(surface("surface:3")));
    }

    #[test]
    fn close_last_surface_is_rejected() {
        let err = close_hosted_surface(
            &window(vec![surface("surface:1")], Some(surface("surface:1"))),
            &surface("surface:1"),
        )
        .expect_err("last surface should not close");

        assert_eq!(
            err,
            HostedSurfaceLifecycleError::LastSurfaceInWindow {
                surface_id: surface("surface:1")
            }
        );
    }

    #[test]
    fn missing_active_surface_normalizes_to_first_surface() {
        let normalized = normalize_active_surface(window(
            vec![surface("surface:1"), surface("surface:2")],
            Some(surface("surface:missing")),
        ));

        assert_eq!(normalized.active_surface_id, Some(surface("surface:1")));
    }

    #[test]
    fn empty_window_normalizes_to_no_active_surface() {
        let normalized =
            normalize_active_surface(window(Vec::new(), Some(surface("surface:missing"))));

        assert_eq!(normalized.active_surface_id, None);
    }

    #[test]
    fn reorder_preserves_active_surface() {
        let reordered = reorder_hosted_surfaces(
            &window(
                vec![
                    surface("surface:1"),
                    surface("surface:2"),
                    surface("surface:3"),
                ],
                Some(surface("surface:2")),
            ),
            vec![
                surface("surface:3"),
                surface("surface:2"),
                surface("surface:1"),
            ],
        )
        .expect("same surface set should reorder");

        assert_eq!(
            reordered.surface_ids,
            vec![
                surface("surface:3"),
                surface("surface:2"),
                surface("surface:1")
            ]
        );
        assert_eq!(reordered.active_surface_id, Some(surface("surface:2")));
    }

    #[test]
    fn reorder_rejects_mismatched_surface_set() {
        let err = reorder_hosted_surfaces(
            &window(vec![surface("surface:1"), surface("surface:2")], None),
            vec![surface("surface:1"), surface("surface:3")],
        )
        .expect_err("mismatched surface set should fail");

        assert_eq!(err, HostedSurfaceLifecycleError::ReorderMismatch);
    }
}
