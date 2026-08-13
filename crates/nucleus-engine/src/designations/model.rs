//! Orchestrator designation model and repository traits.
//!
//! A designation (contract 033 Orchestrator Designation Rule) binds one
//! operator-chosen provider instance to a project as the project's
//! orchestrator, carrying a deny-by-default grant envelope: allowed worker
//! provider instances and models, concurrent-run and per-run budgets,
//! allowed delegation actions, and whether worker steering is permitted.
//! Grants are deny-by-default; an action outside the envelope is rejected
//! before dispatch with the refusal recorded.

use nucleus_core::{PersistenceRecordId, PersistenceRecordKind, RevisionId};
use serde::{Deserialize, Serialize};

use crate::EngineRevisionExpectation;

/// Stable designation id: `designation:<project>:<instance>`.
#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub struct EngineOrchestratorDesignationId(pub String);

/// Delegation actions the envelope may grant (contract 033 Delegation Action
/// Rule). `message_run` / steering is lane phase 4 and is deliberately absent
/// from the phase-3 tool set; the envelope's steering flag is recorded for
/// that phase.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EngineDelegationAction {
    Delegate,
    RunStatus,
    CancelRun,
    AcceptDelivery,
    RejectDelivery,
}

/// Designation lifecycle status. Revocation cancels no running work but
/// blocks new delegation.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EngineOrchestratorDesignationStatus {
    Active,
    Revoked,
}

/// Durable designation payload (contract 033 Orchestrator Designation Rule).
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EngineOrchestratorDesignation {
    pub designation_id: String,
    pub project_id: String,
    /// The designated orchestrator provider instance id. The session's route
    /// must carry this instance to receive the delegation tools.
    pub orchestrator_provider_instance: String,
    /// Allowlisted worker provider instance ids. `None` = unconstrained;
    /// `Some(empty)` = no worker provider may be delegated (deny all).
    pub allowed_worker_provider_instances: Option<Vec<String>>,
    /// Allowlisted worker model ids. `None` = unconstrained;
    /// `Some(empty)` = no worker model may be delegated (deny all).
    pub allowed_worker_models: Option<Vec<String>>,
    /// Concurrent-run budget: the maximum number of non-terminal runs this
    /// designation may own at once. Enforcement fails closed before dispatch.
    pub concurrent_run_budget: u64,
    /// Per-run token budget cap. `None` = the envelope does not cap the
    /// per-run token budget requested by a delegate call.
    pub per_run_token_budget: Option<u64>,
    /// Per-run time budget cap in seconds. `None` = uncapped.
    pub per_run_time_budget_seconds: Option<u64>,
    /// Allowed delegation actions; anything not listed is denied.
    pub allowed_actions: Vec<EngineDelegationAction>,
    /// Whether worker steering (`message_run`) is permitted. Recorded for
    /// lane phase 4; no phase-3 tool consumes it.
    pub steering_permitted: bool,
    pub status: EngineOrchestratorDesignationStatus,
    pub created_at: u64,
    pub updated_at: u64,
}

/// Storage-facing designation record (mirrors `EngineRunRecord`).
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineOrchestratorDesignationRecord {
    pub id: PersistenceRecordId,
    pub kind: PersistenceRecordKind,
    pub revision_id: RevisionId,
    pub payload: Vec<u8>,
}

/// Designation lifecycle commands. Every command produces a spine event and
/// a runtime receipt (contract 033 Audit Rule).
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EngineOrchestratorDesignationCommand {
    Designate(EngineDesignateCommand),
    Revoke(EngineRevokeDesignationCommand),
}

/// Designate (create) or re-designate (replace the envelope) one project
/// orchestrator. `expected_revision: None` creates (`MustNotExist`);
/// `Some(revision)` replaces an existing designation at that revision.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineDesignateCommand {
    pub designation_id: EngineOrchestratorDesignationId,
    pub project_id: String,
    pub orchestrator_provider_instance: String,
    pub allowed_worker_provider_instances: Option<Vec<String>>,
    pub allowed_worker_models: Option<Vec<String>>,
    pub concurrent_run_budget: u64,
    pub per_run_token_budget: Option<u64>,
    pub per_run_time_budget_seconds: Option<u64>,
    pub allowed_actions: Vec<EngineDelegationAction>,
    pub steering_permitted: bool,
    pub expected_revision: Option<RevisionId>,
}

/// Revoke a designation. Revocation cancels no running work but blocks new
/// delegation; already-revoked designations reject the command.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineRevokeDesignationCommand {
    pub designation_id: EngineOrchestratorDesignationId,
    pub expected_revision: Option<RevisionId>,
}

/// Engine designation repository port implemented by host adapters.
pub trait EngineOrchestratorDesignationRepository {
    type Error;

    fn get_designation(
        &self,
        designation_id: &PersistenceRecordId,
    ) -> Result<Option<EngineOrchestratorDesignationRecord>, Self::Error>;

    fn put_designation(
        &self,
        record: EngineOrchestratorDesignationRecord,
        revision: EngineRevisionExpectation,
    ) -> Result<(), Self::Error>;
}

/// Outcome of one accepted designation command.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EngineOrchestratorDesignationCommandOutcome {
    Designated {
        designation: EngineOrchestratorDesignation,
    },
    Revoked {
        designation: EngineOrchestratorDesignation,
    },
}

/// Designation command failure vocabulary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EngineOrchestratorDesignationCommandError<E> {
    InvalidRequest { reason: String },
    NotFound { reason: String },
    Conflict { reason: String },
    Storage(E),
}

/// Designation storage codec failure.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineOrchestratorDesignationCodecError {
    pub reason: String,
}

impl std::fmt::Display for EngineOrchestratorDesignationCodecError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "designation storage codec error: {}", self.reason)
    }
}

impl std::error::Error for EngineOrchestratorDesignationCodecError {}

pub fn encode_orchestrator_designation(
    designation: &EngineOrchestratorDesignation,
) -> Result<Vec<u8>, EngineOrchestratorDesignationCodecError> {
    serde_json::to_vec(designation).map_err(codec_error)
}

pub fn decode_orchestrator_designation(
    bytes: &[u8],
) -> Result<EngineOrchestratorDesignation, EngineOrchestratorDesignationCodecError> {
    serde_json::from_slice(bytes).map_err(codec_error)
}

fn codec_error(error: serde_json::Error) -> EngineOrchestratorDesignationCodecError {
    EngineOrchestratorDesignationCodecError {
        reason: error.to_string(),
    }
}
