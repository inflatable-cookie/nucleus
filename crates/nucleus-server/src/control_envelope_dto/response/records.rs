//! Response record DTOs.

use serde::{Deserialize, Serialize};

use nucleus_command_policy::CommandEvidence;

use crate::client_protocol::{
    ProjectAuthorityDomainPublication, ProjectAuthorityMapPublicationRecord,
    ProjectAuthorityPublicationState, ProjectAuthorityValidationIssue,
};
use crate::control_api::{ServerDiagnosticsQueryResult, ServerDiagnosticsSnapshot};
use crate::diagnostics_read_models::{
    EffigyDiagnosticsDto, ScmSessionDiagnosticsDto, StewardDiagnosticsDto, SyncDiagnosticsDto,
};
use crate::host_authority::ProjectAuthorityDomain;
use crate::runtime_readiness_diagnostics::{RuntimeReadinessBlocker, RuntimeReadinessDiagnostics};

use super::helpers::{
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

/// Serializable task timeline entry.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlTaskTimelineEntryDto {
    pub entry_id: String,
    pub task_id: String,
    pub kind: String,
    pub source_command_id: String,
    pub source_event_id: String,
    pub source_projection_id: String,
    pub summary: String,
}

/// Serializable project authority-map publication.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlProjectAuthorityMapDto {
    pub project_id: String,
    pub domains: Vec<ControlProjectAuthorityDomainDto>,
    pub issues: Vec<ControlProjectAuthorityIssueDto>,
}

/// Serializable project authority-domain publication.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlProjectAuthorityDomainDto {
    pub domain: String,
    pub state: String,
    pub authoritative_host_id: Option<String>,
    pub fallback_host_ids: Vec<String>,
    pub mutation_allowed: Option<bool>,
    pub reason: Option<String>,
    pub note: Option<String>,
}

/// Serializable authority-map validation issue.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlProjectAuthorityIssueDto {
    pub kind: String,
    pub domain: Option<String>,
    pub host_id: Option<String>,
    pub reason: Option<String>,
}

/// Serializable diagnostics query result.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "domain", content = "record", rename_all = "snake_case")]
pub enum ControlDiagnosticsResultDto {
    Steward(StewardDiagnosticsDto),
    Effigy(EffigyDiagnosticsDto),
    ManagementSync(SyncDiagnosticsDto),
    ScmSession(ScmSessionDiagnosticsDto),
    All(ControlDiagnosticsSnapshotDto),
}

/// Serializable combined diagnostics snapshot.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlDiagnosticsSnapshotDto {
    pub steward: StewardDiagnosticsDto,
    pub effigy: EffigyDiagnosticsDto,
    pub management_sync: SyncDiagnosticsDto,
    pub scm_session: ScmSessionDiagnosticsDto,
}

impl From<&ServerDiagnosticsQueryResult> for ControlDiagnosticsResultDto {
    fn from(result: &ServerDiagnosticsQueryResult) -> Self {
        match result {
            ServerDiagnosticsQueryResult::Steward(record) => Self::Steward(record.clone()),
            ServerDiagnosticsQueryResult::Effigy(record) => Self::Effigy(record.clone()),
            ServerDiagnosticsQueryResult::ManagementSync(record) => {
                Self::ManagementSync(record.clone())
            }
            ServerDiagnosticsQueryResult::ScmSession(record) => Self::ScmSession(record.clone()),
            ServerDiagnosticsQueryResult::All(snapshot) => {
                Self::All(ControlDiagnosticsSnapshotDto::from(snapshot))
            }
        }
    }
}

impl From<&ServerDiagnosticsSnapshot> for ControlDiagnosticsSnapshotDto {
    fn from(snapshot: &ServerDiagnosticsSnapshot) -> Self {
        Self {
            steward: snapshot.steward.clone(),
            effigy: snapshot.effigy.clone(),
            management_sync: snapshot.management_sync.clone(),
            scm_session: snapshot.scm_session.clone(),
        }
    }
}

impl From<&ProjectAuthorityMapPublicationRecord> for ControlProjectAuthorityMapDto {
    fn from(record: &ProjectAuthorityMapPublicationRecord) -> Self {
        Self {
            project_id: record.project_id.0.clone(),
            domains: record
                .domains
                .iter()
                .map(ControlProjectAuthorityDomainDto::from)
                .collect(),
            issues: record
                .issues
                .iter()
                .map(ControlProjectAuthorityIssueDto::from)
                .collect(),
        }
    }
}

impl From<&ProjectAuthorityDomainPublication> for ControlProjectAuthorityDomainDto {
    fn from(publication: &ProjectAuthorityDomainPublication) -> Self {
        match &publication.state {
            ProjectAuthorityPublicationState::Assigned {
                authoritative_host_id,
                fallback_host_ids,
                mutation_allowed,
            } => Self {
                domain: authority_domain_dto(&publication.domain),
                state: "assigned".to_owned(),
                authoritative_host_id: Some(authoritative_host_id.0.clone()),
                fallback_host_ids: fallback_host_ids
                    .iter()
                    .map(|host| host.0.clone())
                    .collect(),
                mutation_allowed: Some(*mutation_allowed),
                reason: None,
                note: publication.note.clone(),
            },
            ProjectAuthorityPublicationState::MutationDenied {
                authoritative_host_id,
                fallback_host_ids,
            } => Self {
                domain: authority_domain_dto(&publication.domain),
                state: "mutation_denied".to_owned(),
                authoritative_host_id: Some(authoritative_host_id.0.clone()),
                fallback_host_ids: fallback_host_ids
                    .iter()
                    .map(|host| host.0.clone())
                    .collect(),
                mutation_allowed: Some(false),
                reason: None,
                note: publication.note.clone(),
            },
            ProjectAuthorityPublicationState::FallbackOnly { fallback_host_ids } => Self {
                domain: authority_domain_dto(&publication.domain),
                state: "fallback_only".to_owned(),
                authoritative_host_id: None,
                fallback_host_ids: fallback_host_ids
                    .iter()
                    .map(|host| host.0.clone())
                    .collect(),
                mutation_allowed: None,
                reason: None,
                note: publication.note.clone(),
            },
            ProjectAuthorityPublicationState::Unassigned => Self {
                domain: authority_domain_dto(&publication.domain),
                state: "unassigned".to_owned(),
                authoritative_host_id: None,
                fallback_host_ids: Vec::new(),
                mutation_allowed: None,
                reason: None,
                note: publication.note.clone(),
            },
            ProjectAuthorityPublicationState::PublicationDeferred { reason } => Self {
                domain: authority_domain_dto(&publication.domain),
                state: "publication_deferred".to_owned(),
                authoritative_host_id: None,
                fallback_host_ids: Vec::new(),
                mutation_allowed: None,
                reason: Some(reason.clone()),
                note: publication.note.clone(),
            },
        }
    }
}

impl From<&ProjectAuthorityValidationIssue> for ControlProjectAuthorityIssueDto {
    fn from(issue: &ProjectAuthorityValidationIssue) -> Self {
        match issue {
            ProjectAuthorityValidationIssue::DomainUnassigned { domain } => Self {
                kind: "domain_unassigned".to_owned(),
                domain: Some(authority_domain_dto(domain)),
                host_id: None,
                reason: None,
            },
            ProjectAuthorityValidationIssue::PublicationDeferred { reason } => Self {
                kind: "publication_deferred".to_owned(),
                domain: None,
                host_id: None,
                reason: Some(reason.clone()),
            },
            ProjectAuthorityValidationIssue::FallbackDuplicatesAuthority { domain, host_id } => {
                Self {
                    kind: "fallback_duplicates_authority".to_owned(),
                    domain: Some(authority_domain_dto(domain)),
                    host_id: Some(host_id.0.clone()),
                    reason: None,
                }
            }
        }
    }
}

fn authority_domain_dto(domain: &ProjectAuthorityDomain) -> String {
    match domain {
        ProjectAuthorityDomain::Project => "project".to_owned(),
        ProjectAuthorityDomain::Source => "source".to_owned(),
        ProjectAuthorityDomain::Task => "task".to_owned(),
        ProjectAuthorityDomain::Workspace => "workspace".to_owned(),
        ProjectAuthorityDomain::Session => "session".to_owned(),
        ProjectAuthorityDomain::Execution => "execution".to_owned(),
        ProjectAuthorityDomain::ScmForge => "scm_forge".to_owned(),
        ProjectAuthorityDomain::Memory => "memory".to_owned(),
        ProjectAuthorityDomain::Planning => "planning".to_owned(),
        ProjectAuthorityDomain::Research => "research".to_owned(),
        ProjectAuthorityDomain::Credential => "credential".to_owned(),
        ProjectAuthorityDomain::AuditEvidence => "audit_evidence".to_owned(),
        ProjectAuthorityDomain::Projection => "projection".to_owned(),
        ProjectAuthorityDomain::Custom(value) => value.clone(),
    }
}

impl From<&nucleus_engine::EngineTaskTimelineEntry> for ControlTaskTimelineEntryDto {
    fn from(entry: &nucleus_engine::EngineTaskTimelineEntry) -> Self {
        Self {
            entry_id: entry.entry_id.0.clone(),
            task_id: entry.task_id.0.clone(),
            kind: match entry.kind {
                nucleus_engine::EngineTaskTimelineEntryKind::TaskCommandAdmitted => {
                    "task_command_admitted".to_owned()
                }
            },
            source_command_id: entry.source_command_id.clone(),
            source_event_id: entry.source_event_id.clone(),
            source_projection_id: entry.source_cursor.projection_id.clone(),
            summary: entry.summary.text.clone(),
        }
    }
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
