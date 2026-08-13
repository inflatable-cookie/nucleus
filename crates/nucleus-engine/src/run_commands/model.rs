//! Run command model and repository traits.
//!
//! The run record is the orchestration aggregate: it binds the objective,
//! worktree, provider, orchestrator designation, operation identity,
//! lifecycle state, budget envelope, closeout, and transition history for one
//! harness-owned worker run (contract 033 Run Record Rule). Commands mutate
//! it; the transition log records every accepted lifecycle move; the spine
//! event journal and runtime receipts carry the audit trail.

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_projects::ProjectId;
use serde::{Deserialize, Serialize};

use crate::EngineRevisionExpectation;

/// Stable orchestration run id.
#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub struct EngineRunId(pub String);

/// Run lifecycle state (contract 033 Run Record Rule).
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EngineRunLifecycleState {
    Proposed,
    Dispatched,
    Running,
    Delivered,
    Accepted,
    Rejected,
    Failed,
    Cancelled,
}

/// Card-shaped worker brief: scope, acceptance, stop conditions.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EngineRunObjective {
    pub scope: String,
    pub acceptance: Vec<String>,
    pub stop_conditions: Vec<String>,
}

/// Per-run budget envelope. Phase 1 records the envelope; enforcement lands
/// with delegation (lane phase 4) and must fail closed, visibly.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct EngineRunBudgetEnvelope {
    pub token_budget: Option<u64>,
    pub time_budget_seconds: Option<u64>,
}

/// Structured completion required before a run may be delivered.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EngineRunCloseout {
    pub summary: String,
    pub evidence_refs: Vec<String>,
    pub diff_ref: Option<String>,
}

/// One accepted lifecycle move, append-only on the run record.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EngineRunTransitionRecord {
    pub command_id: String,
    pub from: Option<EngineRunLifecycleState>,
    pub to: EngineRunLifecycleState,
    pub at: u64,
}

/// Durable run record payload (contract 033 Run Record Rule).
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EngineRunStorageRecord {
    pub run_id: EngineRunId,
    pub project_id: String,
    pub objective: EngineRunObjective,
    pub worktree_ref: Option<String>,
    /// The commit the run branch forked from (primary repo HEAD at dispatch).
    /// The delivery review diff is computed against this ref.
    #[serde(default)]
    pub base_ref: Option<String>,
    pub provider_instance: String,
    pub provider_model: String,
    pub orchestrator_designation: Option<String>,
    pub operation_id: Option<String>,
    pub conversation_id: Option<String>,
    pub state: EngineRunLifecycleState,
    pub budget: EngineRunBudgetEnvelope,
    pub closeout: Option<EngineRunCloseout>,
    pub transitions: Vec<EngineRunTransitionRecord>,
    pub created_at: u64,
    pub updated_at: u64,
}

/// Storage-facing run record (mirrors `EngineTaskRecord`).
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineRunRecord {
    pub id: PersistenceRecordId,
    pub domain: PersistenceDomain,
    pub kind: PersistenceRecordKind,
    pub revision_id: RevisionId,
    pub payload: Vec<u8>,
}

/// Run lifecycle commands. Every transition is a command; every command
/// produces a spine event and a runtime receipt (contract 033).
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EngineRunCommand {
    Propose(EngineRunProposeCommand),
    Dispatch(EngineRunDispatchCommand),
    MarkRunning(EngineRunTransitionCommand),
    Deliver(EngineRunDeliverCommand),
    Accept(EngineRunTransitionCommand),
    Reject(EngineRunTransitionCommand),
    Fail(EngineRunTransitionCommand),
    Cancel(EngineRunTransitionCommand),
}

/// Propose a new run record in `proposed` state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineRunProposeCommand {
    pub run_id: EngineRunId,
    pub project_id: ProjectId,
    pub objective: EngineRunObjective,
    pub worktree_ref: Option<String>,
    pub provider_instance: String,
    pub provider_model: String,
    pub orchestrator_designation: Option<String>,
    pub budget: EngineRunBudgetEnvelope,
}

/// Dispatch transitions `proposed -> dispatched` and binds the worker
/// operation identity when the spawn side knows it.
///
/// `conversation_id` is the deterministic run conversation
/// (`conversation:run:<run_id>`); `operation_id` binds when the first turn
/// actually starts (see `EngineRunTransitionCommand::operation_id` for
/// `MarkRunning`). `worktree_ref` binds the realized isolated worktree
/// identity once the gated creation succeeded.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineRunDispatchCommand {
    pub run_id: EngineRunId,
    pub operation_id: Option<String>,
    pub conversation_id: Option<String>,
    pub worktree_ref: Option<String>,
    /// Fork point of the run branch (primary repo HEAD at dispatch); the
    /// delivery review diff is computed against this ref.
    pub base_ref: Option<String>,
    pub expected_revision: Option<RevisionId>,
}

/// One run lifecycle transition with optional reason (running, accept,
/// reject, fail, cancel).
///
/// `operation_id` binds the observed worker operation identity and is only
/// accepted on `MarkRunning` (contract 033: the run transitions to running
/// from observed operation truth, not timers).
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineRunTransitionCommand {
    pub run_id: EngineRunId,
    pub operation_id: Option<String>,
    pub expected_revision: Option<RevisionId>,
    pub reason: Option<String>,
}

/// Deliver transitions `running -> delivered`; requires the closeout.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineRunDeliverCommand {
    pub run_id: EngineRunId,
    pub closeout: EngineRunCloseout,
    pub expected_revision: Option<RevisionId>,
}

/// Engine run repository port implemented by host adapters.
pub trait EngineRunRepository {
    type Error;

    fn get_run(
        &self,
        run_id: &PersistenceRecordId,
    ) -> Result<Option<EngineRunRecord>, Self::Error>;

    fn put_run(
        &self,
        record: EngineRunRecord,
        revision: EngineRevisionExpectation,
    ) -> Result<(), Self::Error>;
}

/// Outcome of one accepted run command.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EngineRunCommandOutcome {
    Mutated {
        transition: EngineRunTransitionRecord,
    },
}

/// Run command failure vocabulary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EngineRunCommandError<E> {
    InvalidRequest { reason: String },
    InvalidTransition { from: EngineRunLifecycleState, to: EngineRunLifecycleState },
    NotFound { reason: String },
    Conflict { reason: String },
    Unsupported { reason: String },
    Storage(E),
}

/// Run storage codec failure.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineRunRecordCodecError {
    pub reason: String,
}

impl std::fmt::Display for EngineRunRecordCodecError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "run storage codec error: {}", self.reason)
    }
}

impl std::error::Error for EngineRunRecordCodecError {}

pub fn encode_run_storage_record(
    record: &EngineRunStorageRecord,
) -> Result<Vec<u8>, EngineRunRecordCodecError> {
    serde_json::to_vec(record).map_err(codec_error)
}

pub fn encode_run_storage_payload(
    record: &EngineRunStorageRecord,
) -> Result<Vec<u8>, EngineRunRecordCodecError> {
    encode_run_storage_record(record)
}

pub fn decode_run_storage_record(
    bytes: &[u8],
) -> Result<EngineRunStorageRecord, EngineRunRecordCodecError> {
    serde_json::from_slice(bytes).map_err(codec_error)
}

fn codec_error(error: serde_json::Error) -> EngineRunRecordCodecError {
    EngineRunRecordCodecError {
        reason: error.to_string(),
    }
}
