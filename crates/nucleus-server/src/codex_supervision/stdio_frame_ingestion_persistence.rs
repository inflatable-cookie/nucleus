//! Codex stdio frame ingestion persistence.
//!
//! This module persists sanitized stdio frame source and decode evidence. It
//! does not retain raw stdio bytes, replay provider writes, parse live streams,
//! or mutate task state.

mod codec;
mod event_builder;
mod record_builder;
mod store;
#[cfg(test)]
mod tests;
mod types;

pub use store::{persist_codex_stdio_frame_ingestion, read_codex_stdio_frame_ingestion_records};
pub use types::{
    CodexAppServerStdioFrameIngestionPersistenceInput,
    CodexAppServerStdioFrameIngestionPersistenceRecord,
};

const INGESTION_RECORD_PREFIX: &str = "codex-stdio-frame-ingestion:";
