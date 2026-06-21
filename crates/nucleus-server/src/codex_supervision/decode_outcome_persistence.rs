//! Codex stdio decode outcome persistence.
//!
//! This module stores summarized decode outcomes derived from sanitized frame
//! ingestion records. It does not store JSON-RPC payloads, read provider
//! streams, execute provider I/O, or mutate task state.

mod codec;
mod record_builder;
mod store;
#[cfg(test)]
mod tests;
mod types;
mod validation;

pub use store::{persist_codex_decode_outcome, read_codex_decode_outcome_records};
pub use types::{
    CodexAppServerDecodeOutcomePersistenceInput, CodexAppServerDecodeOutcomePersistenceRecord,
};

const DECODE_OUTCOME_PREFIX: &str = "codex-stdio-decode-outcome:";
