//! Codex `turn/start` real-write smoke boundary.
//!
//! This boundary decides whether a `turn/start` handoff has enough explicit
//! evidence to be eligible for a separately-run real provider write smoke. It
//! does not write to Codex stdio, retain raw provider material, schedule
//! retries, answer callbacks, cancel provider work, or mutate task state.

mod decision;
mod diagnostics;
#[cfg(test)]
mod tests;
mod types;

pub use decision::codex_turn_start_executor_smoke_boundary;
pub use types::{
    CodexAppServerTurnStartExecutorSmokeBoundaryBlocker,
    CodexAppServerTurnStartExecutorSmokeBoundaryId,
    CodexAppServerTurnStartExecutorSmokeBoundaryInput,
    CodexAppServerTurnStartExecutorSmokeBoundaryRecord,
    CodexAppServerTurnStartExecutorSmokeBoundaryStatus, CodexAppServerTurnStartExecutorSmokeIntent,
};
