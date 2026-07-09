//! Local workspace hosting and project panel layout types.
//!
//! This crate models local client workspace layout authority. It does not
//! implement rendering, terminal process control, browser control, or client
//! sync yet.

pub mod displays;
pub mod geometry;
pub mod hosted_surfaces;
pub mod ids;
pub mod layout;
pub mod local_layout;
pub mod panels;
pub mod planning;
pub mod project_panels;
pub mod regions;
pub mod surfaces;
pub mod windows;

pub use displays::{DisplayAvailability, DisplayInventory, DisplayRecord};
pub use geometry::{Bounds, WindowGeometry};
pub use hosted_surfaces::{
    close_hosted_surface, normalize_active_surface, reorder_hosted_surfaces, HostedSurface,
    HostedSurfaceLifecycleError, HostedSurfaceLifecycleState, SurfaceAttachmentKind,
    SurfaceAttachmentRef, WindowHostedSurfaces,
};
pub use ids::{
    ClientProfileId, DisplayArrangementSignature, DisplayId, HostWindowId, PanelId, PanelKey,
    ProjectPanelLayoutId, SurfaceId, WindowId, WindowInstanceId, WorkspaceLayoutId,
};
pub use layout::{ClientScope, WorkspaceLayout, WorkspaceLayoutStatus, WorkspaceTimestamps};
pub use local_layout::{
    GlobalShellLayoutRecord, LocalLayoutPersistenceScope, LocalLayoutRecord, LocalLayoutRecordKind,
    ProjectPanelLayoutRecord,
};
pub use panels::{Panel, PanelKind, PanelSizeHint, SplitDirection};
pub use planning::{
    choose_display_id, plan_windows, PlannedWindow, WindowPlanInput, WindowPlanOutput,
};
pub use project_panels::{
    resolve_project_panel_layout, ProjectPanelLayoutRules, ProjectPanelPlacement,
    ProjectPanelResolution, ResolvedRegionPanels, ResolvedSurfacePanels,
};
pub use regions::{
    default_region_order, region_definition, RegionDefinition, RegionFamily, RegionId,
};
pub use surfaces::{Surface, SurfaceAttachmentState, SurfaceKind};
pub use windows::{
    HostWindowInstance, HostWindowRole, WorkspaceWindowConfig, WorkspaceWindowPlacement,
};
