use serde::{Deserialize, Serialize};

use nucleus_command_policy::CommandEvidence;

use crate::runtime_readiness_diagnostics::{RuntimeReadinessBlocker, RuntimeReadinessDiagnostics};

use super::super::helpers::{
    checkpoint_family_dto, checkpoint_recovery_state_dto, checkpoint_ref_dto,
    command_execution_status_dto, diff_summary_confidence_dto, diff_summary_kind_dto,
    retention_dto, runtime_readiness_status_dto, runtime_receipt_family_dto,
    runtime_receipt_ref_dto, runtime_receipt_status_dto, runtime_surface_dto,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlCommandEvidenceRecordDto {
    pub evidence_id: String,
    pub command_request_id: String,
    pub status: String,
    pub exit_status: Option<i32>,
    pub retention: String,
    pub summary: Option<String>,
    pub stdout_artifact_ref: Option<String>,
    pub stderr_artifact_ref: Option<String>,
}

/// Serializable sanitized runtime receipt record.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlRuntimeReceiptRecordDto {
    pub receipt_id: String,
    pub family: String,
    pub status: String,
    pub command_ref: Option<String>,
    pub effect_ref: Option<String>,
    pub evidence_refs: Vec<String>,
    pub artifact_refs: Vec<String>,
    pub summary: Option<String>,
}

/// Serializable sanitized checkpoint record.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlCheckpointRecordDto {
    pub checkpoint_id: String,
    pub family: String,
    pub primary_workflow_ref: String,
    pub project_ref: String,
    pub source_ref: Option<String>,
    pub scm_adapter_ref: Option<String>,
    pub authority_host_ref: String,
    pub created_by_actor_ref: String,
    pub causal_refs: Vec<String>,
    pub parent_checkpoint_refs: Vec<String>,
    pub artifact_refs: Vec<String>,
    pub summary: Option<String>,
    pub recovery_state: String,
}

/// Serializable sanitized diff summary record.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlDiffSummaryRecordDto {
    pub diff_id: String,
    pub kind: String,
    pub source_boundary_ref: String,
    pub target_boundary_ref: String,
    pub source_ref: Option<String>,
    pub adapter_ref: Option<String>,
    pub generated_by_ref: String,
    pub confidence: String,
    pub summary: String,
    pub changed_paths: Vec<String>,
    pub evidence_refs: Vec<String>,
    pub artifact_refs: Vec<String>,
}

/// Serializable sanitized runtime readiness diagnostics record.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlRuntimeReadinessDiagnosticDto {
    pub host_id: String,
    pub runtime_surface: String,
    pub status: String,
    pub blockers: Vec<ControlRuntimeReadinessBlockerDto>,
    pub evidence_refs: Vec<String>,
    pub repair_hints: Vec<String>,
    pub summary: Option<String>,
}

/// Serializable sanitized runtime readiness blocker.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlRuntimeReadinessBlockerDto {
    pub source: String,
    pub code: String,
    pub message: String,
}
impl From<&CommandEvidence> for ControlCommandEvidenceRecordDto {
    fn from(evidence: &CommandEvidence) -> Self {
        Self {
            evidence_id: evidence.id.0.clone(),
            command_request_id: evidence.request_id.0.clone(),
            status: command_execution_status_dto(&evidence.status),
            exit_status: evidence.exit_status,
            retention: retention_dto(&evidence.retention),
            summary: evidence.summary.clone(),
            stdout_artifact_ref: evidence.stdout_artifact_ref.clone(),
            stderr_artifact_ref: evidence.stderr_artifact_ref.clone(),
        }
    }
}

impl From<&nucleus_engine::EngineRuntimeReceiptRecord> for ControlRuntimeReceiptRecordDto {
    fn from(receipt: &nucleus_engine::EngineRuntimeReceiptRecord) -> Self {
        Self {
            receipt_id: receipt.receipt_id.0.clone(),
            family: runtime_receipt_family_dto(&receipt.family),
            status: runtime_receipt_status_dto(&receipt.status),
            command_ref: receipt.command_ref.as_ref().map(runtime_receipt_ref_dto),
            effect_ref: receipt.effect_ref.as_ref().map(runtime_receipt_ref_dto),
            evidence_refs: receipt
                .evidence_refs
                .iter()
                .map(runtime_receipt_ref_dto)
                .collect(),
            artifact_refs: receipt
                .artifact_refs
                .iter()
                .map(runtime_receipt_ref_dto)
                .collect(),
            summary: receipt.summary.clone(),
        }
    }
}

impl From<&nucleus_engine::EngineCheckpointRecord> for ControlCheckpointRecordDto {
    fn from(record: &nucleus_engine::EngineCheckpointRecord) -> Self {
        Self {
            checkpoint_id: record.checkpoint_id.0.clone(),
            family: checkpoint_family_dto(&record.family),
            primary_workflow_ref: checkpoint_ref_dto(&record.primary_workflow_ref),
            project_ref: checkpoint_ref_dto(&record.project_ref),
            source_ref: record.source_ref.as_ref().map(checkpoint_ref_dto),
            scm_adapter_ref: record.scm_adapter_ref.as_ref().map(checkpoint_ref_dto),
            authority_host_ref: checkpoint_ref_dto(&record.authority_host_ref),
            created_by_actor_ref: checkpoint_ref_dto(&record.created_by_actor_ref),
            causal_refs: record.causal_refs.iter().map(checkpoint_ref_dto).collect(),
            parent_checkpoint_refs: record
                .parent_checkpoint_refs
                .iter()
                .map(checkpoint_ref_dto)
                .collect(),
            artifact_refs: record
                .artifact_refs
                .iter()
                .map(checkpoint_ref_dto)
                .collect(),
            summary: record.summary.clone(),
            recovery_state: checkpoint_recovery_state_dto(&record.recovery_state),
        }
    }
}

impl From<&nucleus_engine::EngineDiffSummaryRecord> for ControlDiffSummaryRecordDto {
    fn from(record: &nucleus_engine::EngineDiffSummaryRecord) -> Self {
        Self {
            diff_id: record.diff_id.0.clone(),
            kind: diff_summary_kind_dto(&record.kind),
            source_boundary_ref: checkpoint_ref_dto(&record.source_boundary_ref),
            target_boundary_ref: checkpoint_ref_dto(&record.target_boundary_ref),
            source_ref: record.source_ref.as_ref().map(checkpoint_ref_dto),
            adapter_ref: record.adapter_ref.as_ref().map(checkpoint_ref_dto),
            generated_by_ref: checkpoint_ref_dto(&record.generated_by_ref),
            confidence: diff_summary_confidence_dto(&record.confidence),
            summary: record.summary.clone(),
            changed_paths: record.changed_paths.clone(),
            evidence_refs: record
                .evidence_refs
                .iter()
                .map(checkpoint_ref_dto)
                .collect(),
            artifact_refs: record
                .artifact_refs
                .iter()
                .map(checkpoint_ref_dto)
                .collect(),
        }
    }
}

impl From<&RuntimeReadinessDiagnostics> for ControlRuntimeReadinessDiagnosticDto {
    fn from(diagnostics: &RuntimeReadinessDiagnostics) -> Self {
        Self {
            host_id: diagnostics.host_id.0.clone(),
            runtime_surface: runtime_surface_dto(&diagnostics.surface),
            status: runtime_readiness_status_dto(&diagnostics.status),
            blockers: diagnostics
                .blockers
                .iter()
                .map(ControlRuntimeReadinessBlockerDto::from)
                .collect(),
            evidence_refs: diagnostics.evidence_refs.clone(),
            repair_hints: diagnostics.repair_hints.clone(),
            summary: diagnostics.summary.clone(),
        }
    }
}

impl From<&RuntimeReadinessBlocker> for ControlRuntimeReadinessBlockerDto {
    fn from(blocker: &RuntimeReadinessBlocker) -> Self {
        Self {
            source: blocker.source.clone(),
            code: blocker.code.clone(),
            message: blocker.message.clone(),
        }
    }
}
