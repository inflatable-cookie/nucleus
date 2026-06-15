//! Persisted project workspace layout types.
//!
//! This crate names workspace layout records only. It does not implement
//! rendering, terminal process control, browser control, or client sync yet.

pub mod ids;
pub mod layout;
pub mod panels;
pub mod surfaces;

pub use ids::{PanelId, SurfaceId, WorkspaceLayoutId};
pub use layout::{ClientScope, WorkspaceLayout, WorkspaceLayoutStatus, WorkspaceTimestamps};
pub use panels::{Panel, PanelKind, PanelSizeHint, SplitDirection};
pub use surfaces::{Surface, SurfaceAttachmentState, SurfaceKind};
