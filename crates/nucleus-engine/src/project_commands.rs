//! Engine project lifecycle command boundary.
//!
//! Canonical project create/rename/park/archive/restore/delete rules —
//! authority checks, idempotency fingerprints, deletion-impact refusal —
//! live here behind a repository port; hosts map DTOs and implement
//! storage and receipt access.

mod model;
mod service;
#[cfg(test)]
mod tests;

pub use model::{
    EngineProjectCommand, EngineProjectCommandError, EngineProjectCreateCommand,
    EngineProjectLifecycleAction, EngineProjectLifecycleCommand, EngineProjectLifecycleReceipt,
    EngineProjectRepository, EngineProjectRetentionChoice, EngineProjectScanDomain,
};
pub use service::EngineProjectCommandService;
