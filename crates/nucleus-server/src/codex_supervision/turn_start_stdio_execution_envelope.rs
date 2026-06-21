//! Codex `turn/start` stdio execution envelope records.
//!
//! These records prepare a provider transport executor handoff from existing
//! authority, send-command, preflight, write-attempt, and receipt/event
//! evidence. They do not write to Codex stdio, retain raw payloads or streams,
//! answer callbacks, schedule retries, or mutate task state.

mod decision;
#[cfg(test)]
mod tests;
mod types;

pub use decision::codex_turn_start_stdio_execution_envelope;
pub use types::{
    CodexAppServerTurnStartStdioExecutionEnvelopeBlocker,
    CodexAppServerTurnStartStdioExecutionEnvelopeId,
    CodexAppServerTurnStartStdioExecutionEnvelopeInput,
    CodexAppServerTurnStartStdioExecutionEnvelopeRecord,
    CodexAppServerTurnStartStdioExecutionEnvelopeStatus, CodexAppServerTurnStartStdioPayloadRef,
};
