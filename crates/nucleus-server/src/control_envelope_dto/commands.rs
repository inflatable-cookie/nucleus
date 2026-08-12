//! Command DTO codec: the serializable command surface and its server-command
//! round trip.
//!
//! Module index over the command surface: wire types, decode, and encode.

mod decode;
mod encode;
mod goal_authoring;
mod memory_proposal_review;
mod project_lifecycle;
mod read_only;
mod task_authoring;
mod types;

pub use types::{
    ControlCommandDto, ControlManagementProjectionSyncPolicyDto, ControlProjectLifecycleActionDto,
    ControlProjectResourceActionDto, ControlProjectResourceRoleDto,
};
