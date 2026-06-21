//! Durable Codex live-smoke evidence persistence.
//!
//! Persistence stores sanitized smoke evidence and, for first write attempts,
//! an accepted live-executor outcome/receipt. It does not execute provider I/O
//! or retain raw provider material.

mod helpers;
mod record_builder;
mod store;
#[cfg(test)]
mod tests;
mod types;
mod validation;

pub use store::{
    persist_durable_codex_live_smoke_evidence, read_durable_codex_live_smoke_evidence_records,
};
pub use types::{
    DurableCodexLiveSmokeEvidencePersistenceInput, DurableCodexLiveSmokeEvidenceRecord,
    DurableCodexLiveSmokeEvidenceStatus,
};

const DURABLE_CODEX_LIVE_SMOKE_EVIDENCE_PREFIX: &str = "durable-codex-live-smoke-evidence:";
