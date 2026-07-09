//! Workspace surface types.

use crate::ids::SurfaceId;

/// Open surface descriptor used by project panel layout records.
///
/// Window-owned hosting state lives in `hosted_surfaces`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Surface {
    pub id: SurfaceId,
    pub kind: SurfaceKind,
    pub title: String,
    pub attachment: SurfaceAttachmentState,
    pub metadata: Vec<SurfaceMetadata>,
}

/// Supported workspace surface categories.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SurfaceKind {
    AgentPane,
    Terminal,
    Browser,
    TextEditor,
    CodeEditor,
    FileView,
    ScmChanges,
    ScmDiff,
    ScmCommit,
    Notes,
    TaskView,
    Other(String),
}

/// Whether the surface is attached to a live server-managed resource.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SurfaceAttachmentState {
    Detached,
    Attached { resource_id: String },
    Missing { reason: String },
}

/// Provider or client metadata attached to a surface.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SurfaceMetadata {
    pub key: String,
    pub value: String,
}
