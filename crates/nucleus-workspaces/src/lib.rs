//! Product workspace planning types.
//!
//! Durable desktop layout authority belongs to Longhorn's registered layout
//! domain. These records remain only for product/server planning references;
//! they do not model displays, host windows, regions, or local persistence.

pub mod ids;
pub mod layout;
pub mod panels;

pub use ids::{PanelId, WorkspaceLayoutId};
pub use layout::{ClientScope, WorkspaceLayout, WorkspaceLayoutStatus, WorkspaceTimestamps};
pub use panels::{Panel, PanelKind, PanelSizeHint, SplitDirection};
