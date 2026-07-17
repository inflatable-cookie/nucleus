//! Engine goal command boundary.
//!
//! Canonical goal authoring rules (status gates, membership validation,
//! field merge, revision derivation) live here behind a repository port;
//! hosts map DTOs and implement storage access.

mod model;
mod service;
#[cfg(test)]
mod tests;

pub use model::{
    EngineGoalCommand, EngineGoalCommandError, EngineGoalCreateCommand, EngineGoalRepository,
    EngineGoalUpdateChanges, EngineGoalUpdateCommand,
};
pub use service::EngineGoalCommandService;
