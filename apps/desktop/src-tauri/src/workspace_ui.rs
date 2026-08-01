mod dto;
mod legacy;
mod migration;
mod product_state;
mod registry;
mod runtime;

pub use dto::{
    WorkspaceUiConfigDto, WorkspaceUiPaths, WorkspaceWindowBoundsDto, WorkspaceWindowPlacementDto,
};
pub use legacy::split_legacy_workspace_ui_document;
pub use runtime::WorkspaceUiRuntime;

#[cfg(test)]
mod tests;
