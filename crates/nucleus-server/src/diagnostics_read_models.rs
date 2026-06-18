//! Client-safe diagnostics read models.
//!
//! These DTOs expose steward, Effigy, management sync, and SCM session state to
//! clients without granting command authority or copying raw provider output.

use serde::{Deserialize, Serialize};

use nucleus_engine::{
    EngineScmWorkItemLinkRecord, ManagementProjectionCapturePrepRecord,
    ManagementProjectionImportRepairProposal, ManagementProjectionSyncAssistanceRoute,
    ManagementProjectionSyncPlan,
};
use nucleus_native_harness::{
    NativeEffigyHealthSummary, NativeEffigyIntegrationStatus, NativeEffigyProjectIntegration,
    NativeEffigyValidationPlanSummary, NativeStewardCommandAdmission, NativeStewardCommandOutcome,
    NativeStewardProposal,
};
use nucleus_scm_forge::{
    ScmSessionCommandAdmission, ScmWorkingCopySessionMode, ScmWorkingCopySessionPlan,
};

/// Steward diagnostics read model.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct StewardDiagnosticsDto {
    pub proposals: Vec<StewardProposalDiagnosticDto>,
    pub command_admissions: Vec<StewardCommandAdmissionDiagnosticDto>,
    pub command_outcomes: Vec<StewardCommandOutcomeDiagnosticDto>,
    pub client_can_mutate: bool,
    pub source_status: String,
    pub source_summary: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct StewardProposalDiagnosticDto {
    pub proposal_id: String,
    pub kind: String,
    pub review: String,
    pub requires_human_approval: bool,
    pub evidence_refs: Vec<String>,
    pub receipt_refs: Vec<String>,
    pub summary: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct StewardCommandAdmissionDiagnosticDto {
    pub command_id: String,
    pub status: String,
    pub terminal: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct StewardCommandOutcomeDiagnosticDto {
    pub command_id: String,
    pub status: String,
    pub terminal: bool,
    pub proposal_refs: Vec<String>,
    pub sync_assistance_refs: Vec<String>,
}

pub fn steward_diagnostics(
    proposals: &[NativeStewardProposal],
    admissions: &[NativeStewardCommandAdmission],
    outcomes: &[NativeStewardCommandOutcome],
) -> StewardDiagnosticsDto {
    let record_count = proposals.len() + admissions.len() + outcomes.len();
    StewardDiagnosticsDto {
        proposals: proposals
            .iter()
            .map(StewardProposalDiagnosticDto::from)
            .collect(),
        command_admissions: admissions
            .iter()
            .map(StewardCommandAdmissionDiagnosticDto::from)
            .collect(),
        command_outcomes: outcomes
            .iter()
            .map(StewardCommandOutcomeDiagnosticDto::from)
            .collect(),
        client_can_mutate: false,
        source_status: source_status(record_count),
        source_summary: Some(source_summary(
            record_count,
            "steward source records are not persisted yet",
            "steward diagnostics loaded from source records",
        )),
    }
}

impl From<&NativeStewardProposal> for StewardProposalDiagnosticDto {
    fn from(proposal: &NativeStewardProposal) -> Self {
        Self {
            proposal_id: proposal.id.0.clone(),
            kind: format!("{:?}", proposal.kind),
            review: format!("{:?}", proposal.review),
            requires_human_approval: proposal.requires_human_approval(),
            evidence_refs: proposal
                .evidence_refs
                .iter()
                .map(|evidence| evidence.ref_id.clone())
                .collect(),
            receipt_refs: proposal
                .receipt_refs
                .iter()
                .map(|receipt| receipt.0.clone())
                .collect(),
            summary: proposal.summary.clone(),
        }
    }
}

impl From<&NativeStewardCommandAdmission> for StewardCommandAdmissionDiagnosticDto {
    fn from(admission: &NativeStewardCommandAdmission) -> Self {
        Self {
            command_id: admission.command_id.0.clone(),
            status: format!("{:?}", admission.status),
            terminal: admission.is_rejected_or_blocked(),
        }
    }
}

impl From<&NativeStewardCommandOutcome> for StewardCommandOutcomeDiagnosticDto {
    fn from(outcome: &NativeStewardCommandOutcome) -> Self {
        Self {
            command_id: outcome.command_id.0.clone(),
            status: format!("{:?}", outcome.status),
            terminal: outcome.is_terminal(),
            proposal_refs: outcome
                .proposal_refs
                .iter()
                .map(|proposal| proposal.0.clone())
                .collect(),
            sync_assistance_refs: outcome
                .sync_assistance_refs
                .iter()
                .map(|assistance| assistance.0.clone())
                .collect(),
        }
    }
}

/// Effigy diagnostics read model.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EffigyDiagnosticsDto {
    pub integration_status: String,
    pub selector_refs: Vec<String>,
    pub health_status: Option<String>,
    pub validation_status: Option<String>,
    pub evidence_refs: Vec<String>,
    pub client_can_run_effigy: bool,
    pub source_status: String,
    pub source_summary: Option<String>,
}

pub fn effigy_diagnostics(
    integration: &NativeEffigyProjectIntegration,
    health: Option<&NativeEffigyHealthSummary>,
    validation: Option<&NativeEffigyValidationPlanSummary>,
) -> EffigyDiagnosticsDto {
    let record_count = integration.selectors.len()
        + integration.evidence_refs.len()
        + usize::from(health.is_some())
        + usize::from(validation.is_some());
    EffigyDiagnosticsDto {
        integration_status: format!("{:?}", integration.status),
        selector_refs: integration
            .selectors
            .iter()
            .map(|selector| selector.selector_ref.0.clone())
            .collect(),
        health_status: health.map(|summary| format!("{:?}", summary.status)),
        validation_status: validation.map(|summary| format!("{:?}", summary.status)),
        evidence_refs: integration
            .evidence_refs
            .iter()
            .map(|evidence| evidence.0.clone())
            .collect(),
        client_can_run_effigy: false,
        source_status: effigy_source_status(integration, record_count),
        source_summary: integration.summary.clone().or_else(|| {
            Some(source_summary(
                record_count,
                "effigy source records are not persisted yet",
                "effigy diagnostics loaded from source records",
            ))
        }),
    }
}

/// Management sync diagnostics read model.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SyncDiagnosticsDto {
    pub plans: Vec<SyncPlanDiagnosticDto>,
    pub repairs: Vec<SyncRepairDiagnosticDto>,
    pub assistance_routes: Vec<SyncAssistanceDiagnosticDto>,
    pub capture_preps: Vec<SyncCapturePrepDiagnosticDto>,
    pub client_can_mutate_provider: bool,
    pub source_status: String,
    pub source_summary: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SyncPlanDiagnosticDto {
    pub plan_id: String,
    pub kind: String,
    pub status: String,
    pub file_refs: Vec<String>,
    pub receipt_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SyncRepairDiagnosticDto {
    pub proposal_id: String,
    pub kind: String,
    pub review: String,
    pub file_ref: String,
    pub preserves_incoming_record: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SyncAssistanceDiagnosticDto {
    pub conflict_id: String,
    pub kind: String,
    pub review: String,
    pub requires_human_approval: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SyncCapturePrepDiagnosticDto {
    pub prep_id: String,
    pub plan_id: String,
    pub status: String,
    pub file_refs: Vec<String>,
    pub receipt_ids: Vec<String>,
    pub execution_available: bool,
}

pub fn sync_diagnostics(
    plans: &[ManagementProjectionSyncPlan],
    repairs: &[ManagementProjectionImportRepairProposal],
    routes: &[ManagementProjectionSyncAssistanceRoute],
    capture_preps: &[ManagementProjectionCapturePrepRecord],
) -> SyncDiagnosticsDto {
    let record_count = plans.len() + repairs.len() + routes.len() + capture_preps.len();
    SyncDiagnosticsDto {
        plans: plans.iter().map(SyncPlanDiagnosticDto::from).collect(),
        repairs: repairs.iter().map(SyncRepairDiagnosticDto::from).collect(),
        assistance_routes: routes
            .iter()
            .map(SyncAssistanceDiagnosticDto::from)
            .collect(),
        capture_preps: capture_preps
            .iter()
            .map(SyncCapturePrepDiagnosticDto::from)
            .collect(),
        client_can_mutate_provider: false,
        source_status: source_status(record_count),
        source_summary: Some(source_summary(
            record_count,
            "management sync source records are not persisted yet",
            "management sync diagnostics loaded from source records",
        )),
    }
}

impl From<&ManagementProjectionSyncPlan> for SyncPlanDiagnosticDto {
    fn from(plan: &ManagementProjectionSyncPlan) -> Self {
        Self {
            plan_id: plan.plan_id.0.clone(),
            kind: format!("{:?}", plan.kind),
            status: format!("{:?}", plan.status),
            file_refs: plan.file_refs.iter().map(|file| file.0.clone()).collect(),
            receipt_ids: plan
                .receipt_ids
                .iter()
                .map(|receipt| receipt.0.clone())
                .collect(),
        }
    }
}

impl From<&ManagementProjectionImportRepairProposal> for SyncRepairDiagnosticDto {
    fn from(repair: &ManagementProjectionImportRepairProposal) -> Self {
        Self {
            proposal_id: repair.proposal_id.0.clone(),
            kind: format!("{:?}", repair.kind),
            review: format!("{:?}", repair.review),
            file_ref: repair.file_ref.0.clone(),
            preserves_incoming_record: repair.preserves_incoming_record,
        }
    }
}

impl From<&ManagementProjectionSyncAssistanceRoute> for SyncAssistanceDiagnosticDto {
    fn from(route: &ManagementProjectionSyncAssistanceRoute) -> Self {
        Self {
            conflict_id: route.conflict_id.clone(),
            kind: format!("{:?}", route.kind),
            review: format!("{:?}", route.review),
            requires_human_approval: route.requires_human_approval(),
        }
    }
}

impl From<&ManagementProjectionCapturePrepRecord> for SyncCapturePrepDiagnosticDto {
    fn from(prep: &ManagementProjectionCapturePrepRecord) -> Self {
        Self {
            prep_id: prep.prep_id.0.clone(),
            plan_id: prep.plan_id.0.clone(),
            status: format!("{:?}", prep.status),
            file_refs: prep.file_refs.iter().map(|file| file.0.clone()).collect(),
            receipt_ids: prep
                .receipt_ids
                .iter()
                .map(|receipt| receipt.0.clone())
                .collect(),
            execution_available: prep.is_execution(),
        }
    }
}

/// SCM session diagnostics read model.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ScmSessionDiagnosticsDto {
    pub sessions: Vec<ScmSessionPlanDiagnosticDto>,
    pub admissions: Vec<ScmCommandAdmissionDiagnosticDto>,
    pub work_item_links: Vec<ScmWorkItemLinkDiagnosticDto>,
    pub client_can_mutate_working_copy: bool,
    pub source_status: String,
    pub source_summary: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ScmSessionPlanDiagnosticDto {
    pub session_id: String,
    pub repository_id: String,
    pub provider_kind: String,
    pub mode: String,
    pub status: String,
    pub user_can_test_in_known_directory: bool,
    pub runtime_constraints: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ScmCommandAdmissionDiagnosticDto {
    pub command_id: String,
    pub status: String,
    pub required_capability: String,
    pub executes_provider_command: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ScmWorkItemLinkDiagnosticDto {
    pub link_id: String,
    pub task_id: String,
    pub work_item_id: String,
    pub work_session_id: String,
    pub session_command_ids: Vec<String>,
    pub change_refs: Vec<String>,
    pub checkpoint_ids: Vec<String>,
    pub diff_summary_ids: Vec<String>,
    pub requires_repair: bool,
}

pub fn scm_session_diagnostics(
    sessions: &[ScmWorkingCopySessionPlan],
    admissions: &[ScmSessionCommandAdmission],
    links: &[EngineScmWorkItemLinkRecord],
) -> ScmSessionDiagnosticsDto {
    let record_count = sessions.len() + admissions.len() + links.len();
    ScmSessionDiagnosticsDto {
        sessions: sessions
            .iter()
            .map(ScmSessionPlanDiagnosticDto::from)
            .collect(),
        admissions: admissions
            .iter()
            .map(ScmCommandAdmissionDiagnosticDto::from)
            .collect(),
        work_item_links: links
            .iter()
            .map(ScmWorkItemLinkDiagnosticDto::from)
            .collect(),
        client_can_mutate_working_copy: false,
        source_status: source_status(record_count),
        source_summary: Some(source_summary(
            record_count,
            "scm session source records are not persisted yet",
            "scm session diagnostics loaded from source records",
        )),
    }
}

impl From<&ScmWorkingCopySessionPlan> for ScmSessionPlanDiagnosticDto {
    fn from(plan: &ScmWorkingCopySessionPlan) -> Self {
        Self {
            session_id: plan.id.0.clone(),
            repository_id: plan.repository_id.0.clone(),
            provider_kind: format!("{:?}", plan.provider_kind),
            mode: session_mode(&plan.mode),
            status: format!("{:?}", plan.status),
            user_can_test_in_known_directory: plan.testability.user_can_test_in_known_directory,
            runtime_constraints: plan
                .runtime_constraints
                .iter()
                .map(|constraint| format!("{constraint:?}"))
                .collect(),
        }
    }
}

impl From<&ScmSessionCommandAdmission> for ScmCommandAdmissionDiagnosticDto {
    fn from(admission: &ScmSessionCommandAdmission) -> Self {
        Self {
            command_id: admission.command_id.0.clone(),
            status: format!("{:?}", admission.status),
            required_capability: format!("{:?}", admission.required_capability),
            executes_provider_command: admission.executes_provider_command(),
        }
    }
}

impl From<&EngineScmWorkItemLinkRecord> for ScmWorkItemLinkDiagnosticDto {
    fn from(link: &EngineScmWorkItemLinkRecord) -> Self {
        Self {
            link_id: link.link_id.0.clone(),
            task_id: link.task_id.0.clone(),
            work_item_id: link.work_item_id.0.clone(),
            work_session_id: link.work_session_id.0.clone(),
            session_command_ids: link
                .session_command_ids
                .iter()
                .map(|command| command.0.clone())
                .collect(),
            change_refs: link
                .change_refs
                .iter()
                .map(|change| change.provider_ref.0.clone())
                .collect(),
            checkpoint_ids: link
                .checkpoint_ids
                .iter()
                .map(|checkpoint| checkpoint.0.clone())
                .collect(),
            diff_summary_ids: link
                .diff_summary_ids
                .iter()
                .map(|diff| diff.0.clone())
                .collect(),
            requires_repair: link.requires_repair(),
        }
    }
}

fn session_mode(mode: &ScmWorkingCopySessionMode) -> String {
    match mode {
        ScmWorkingCopySessionMode::PrimaryTree { .. } => "primary_tree".to_owned(),
        ScmWorkingCopySessionMode::IsolatedLocation { .. } => "isolated_location".to_owned(),
        ScmWorkingCopySessionMode::ExternalManaged { .. } => "external_managed".to_owned(),
        ScmWorkingCopySessionMode::Unsupported { .. } => "unsupported".to_owned(),
    }
}

fn source_status(record_count: usize) -> String {
    if record_count == 0 {
        "empty".to_owned()
    } else {
        "records".to_owned()
    }
}

fn effigy_source_status(
    integration: &NativeEffigyProjectIntegration,
    record_count: usize,
) -> String {
    if integration.status == NativeEffigyIntegrationStatus::Disabled {
        "disabled".to_owned()
    } else {
        source_status(record_count)
    }
}

fn source_summary(record_count: usize, empty: &str, records: &str) -> String {
    if record_count == 0 {
        empty.to_owned()
    } else {
        records.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nucleus_engine::{
        EngineCheckpointRecordId, EngineDiffSummaryRecordId, EngineRuntimeReceiptRecordId,
        EngineScmWorkItemLinkId, EngineScmWorkItemLinkRecord, EngineScmWorkItemLinkState,
        EngineTaskWorkItemId, ManagementProjectionCapturePrepId,
        ManagementProjectionCapturePrepRecord, ManagementProjectionCapturePrepStatus,
        ManagementProjectionCaptureScope, ManagementProjectionConflictClass,
        ManagementProjectionConflictReport, ManagementProjectionFileRef,
        ManagementProjectionImportRepairProposal, ManagementProjectionImportRepairProposalId,
        ManagementProjectionRecordId, ManagementProjectionSchemaConflictKind,
        ManagementProjectionSyncAssistanceRoute, ManagementProjectionSyncPlan,
        ManagementProjectionSyncPlanId,
    };
    use nucleus_native_harness::{
        NativeEffigyHealthStatus, NativeEffigyHealthSummary, NativeEffigyIntegrationStatus,
        NativeEffigyProjectIntegration, NativeEffigyScope, NativeEffigySelectorKind,
        NativeEffigySelectorRecord, NativeEffigySelectorRef, NativeEffigyValidationPlanSummary,
        NativeStewardCommandAdmission, NativeStewardCommandAdmissionStatus, NativeStewardCommandId,
        NativeStewardCommandOutcome, NativeStewardCommandStatus, NativeStewardEvidenceRef,
        NativeStewardEvidenceSource, NativeStewardProposal, NativeStewardProposalId,
        NativeStewardProposalKind, NativeStewardProposalReview, NativeStewardProposalTarget,
    };
    use nucleus_scm_forge::{
        ScmCapability, ScmChangeKind, ScmChangeRef, ScmProviderKind, ScmProviderRef,
        ScmRepositoryRefId, ScmSessionCommandAdmission, ScmSessionCommandAdmissionStatus,
        ScmSessionCommandId, ScmSessionCommandKind, ScmSessionCommandRequest,
        ScmSessionCommandScope, ScmWorkSessionId, ScmWorkingCopySessionPlan,
    };
    use nucleus_tasks::TaskId;

    #[test]
    fn steward_diagnostics_expose_proposals_commands_and_approval_without_mutation() {
        let proposal = NativeStewardProposal {
            id: NativeStewardProposalId("proposal:1".to_owned()),
            persona_id: None,
            target: NativeStewardProposalTarget::Task {
                task_ref: "task:1".to_owned(),
            },
            kind: NativeStewardProposalKind::ReadinessHint,
            review: NativeStewardProposalReview::NeedsHumanApproval,
            proposed_changes: Vec::new(),
            evidence_refs: vec![NativeStewardEvidenceRef {
                source: NativeStewardEvidenceSource::Task,
                ref_id: "task:1".to_owned(),
            }],
            tool_action_id: None,
            receipt_refs: Vec::new(),
            summary: Some("review task readiness".to_owned()),
        };
        let admission = NativeStewardCommandAdmission {
            command_id: NativeStewardCommandId("steward-command:1".to_owned()),
            status: NativeStewardCommandAdmissionStatus::RequiresApproval,
            approval: nucleus_native_harness::NativeActionApproval::Required,
            reason: Some("approval required".to_owned()),
        };
        let outcome = NativeStewardCommandOutcome {
            command_id: NativeStewardCommandId("steward-command:1".to_owned()),
            status: NativeStewardCommandStatus::Blocked("approval required".to_owned()),
            proposal_refs: vec![NativeStewardProposalId("proposal:1".to_owned())],
            sync_assistance_refs: Vec::new(),
            tool_action_id: None,
            receipt_refs: Vec::new(),
            evidence_refs: Vec::new(),
            summary: Some("blocked pending approval".to_owned()),
        };

        let diagnostics = steward_diagnostics(&[proposal], &[admission], &[outcome]);
        let json = serde_json::to_string(&diagnostics).expect("serialize steward diagnostics");

        assert!(!diagnostics.client_can_mutate);
        assert_eq!(diagnostics.source_status, "records");
        assert!(diagnostics.proposals[0].requires_human_approval);
        assert_eq!(diagnostics.command_admissions[0].status, "RequiresApproval");
        assert!(!json.contains("raw_stdout"));
    }

    #[test]
    fn effigy_diagnostics_expose_health_and_validation_without_raw_output() {
        let integration = NativeEffigyProjectIntegration {
            status: NativeEffigyIntegrationStatus::Enabled,
            scope: NativeEffigyScope::ProjectRoot,
            manifest_ref: None,
            selectors: vec![NativeEffigySelectorRecord {
                selector_ref: NativeEffigySelectorRef("qa:northstar".to_owned()),
                kind: NativeEffigySelectorKind::Validation,
                scope: NativeEffigyScope::ProjectRoot,
                command_scope_hint: nucleus_native_harness::NativeEffigyCommandScopeHint::ReadOnly,
                purpose: Some("docs validation".to_owned()),
                evidence_refs: Vec::new(),
            }],
            evidence_refs: Vec::new(),
            summary: None,
        };
        let health = NativeEffigyHealthSummary {
            status: NativeEffigyHealthStatus::Ok,
            scope: NativeEffigyScope::ProjectRoot,
            tool_action_id: None,
            receipt_refs: Vec::new(),
            evidence_refs: Vec::new(),
            repair_hints: Vec::new(),
            summary: Some("effigy ready".to_owned()),
        };
        let mut validation =
            NativeEffigyValidationPlanSummary::planned_only(NativeEffigyScope::ProjectRoot, vec![]);
        validation.summary = Some("planned only".to_owned());

        let diagnostics = effigy_diagnostics(&integration, Some(&health), Some(&validation));
        let json = serde_json::to_string(&diagnostics).expect("serialize effigy diagnostics");

        assert_eq!(diagnostics.integration_status, "Enabled");
        assert_eq!(diagnostics.selector_refs, vec!["qa:northstar".to_owned()]);
        assert!(!diagnostics.client_can_run_effigy);
        assert_eq!(diagnostics.source_status, "records");
        assert!(!json.contains("raw_stdout"));
    }

    #[test]
    fn management_projection_sync_diagnostics_expose_conflict_state_without_provider_mutation() {
        let plan = ManagementProjectionSyncPlan::capture_preparation(
            ManagementProjectionSyncPlanId("sync-plan:1".to_owned()),
            vec![ManagementProjectionFileRef::task("task:1")],
            vec![EngineRuntimeReceiptRecordId("receipt:1".to_owned())],
        );
        let report = ManagementProjectionConflictReport {
            conflict_id: "conflict:1".to_owned(),
            file_ref: ManagementProjectionFileRef::task("task:1"),
            local_record_ref: None,
            incoming_record_ref: Some(ManagementProjectionRecordId("task:1".to_owned())),
            class: ManagementProjectionConflictClass::Schema(
                ManagementProjectionSchemaConflictKind::InvalidRecordShape,
            ),
            summary: "invalid shape".to_owned(),
        };
        let route = ManagementProjectionSyncAssistanceRoute::from_conflict_report(&report);
        let repair = ManagementProjectionImportRepairProposal {
            proposal_id: ManagementProjectionImportRepairProposalId("repair:1".to_owned()),
            file_ref: ManagementProjectionFileRef::task("task:1"),
            record_ref: Some("task:1".to_owned()),
            kind: nucleus_engine::ManagementProjectionImportRepairKind::SchemaRepair,
            review: nucleus_engine::ManagementProjectionImportRepairReview::ProposalOnly,
            issue_summaries: vec!["invalid shape".to_owned()],
            preserves_incoming_record: true,
        };
        let prep = ManagementProjectionCapturePrepRecord {
            prep_id: ManagementProjectionCapturePrepId("capture-prep:1".to_owned()),
            plan_id: plan.plan_id.clone(),
            status: ManagementProjectionCapturePrepStatus::Draft,
            scope: ManagementProjectionCaptureScope::ManagementProjection,
            file_refs: plan.file_refs.clone(),
            receipt_ids: plan.receipt_ids.clone(),
            assistance_refs: vec!["sync-assist:1".to_owned()],
            summary: None,
        };

        let diagnostics = sync_diagnostics(&[plan], &[repair], &[route], &[prep]);
        let json = serde_json::to_string(&diagnostics).expect("serialize sync diagnostics");

        assert!(!diagnostics.client_can_mutate_provider);
        assert_eq!(diagnostics.source_status, "records");
        assert_eq!(
            diagnostics.assistance_routes[0].kind,
            "MechanicalConflictRepair"
        );
        assert!(!diagnostics.capture_preps[0].execution_available);
        assert!(!json.to_lowercase().contains("push"));
    }

    #[test]
    fn scm_session_diagnostics_expose_session_tradeoffs_and_task_linkage() {
        let session = ScmWorkingCopySessionPlan::isolated_location_session(
            ScmWorkSessionId("scm-session:1".to_owned()),
            ScmRepositoryRefId("repo:nucleus".to_owned()),
            ScmProviderKind::Convergence,
            None,
            None,
            None,
            None,
        );
        let command = ScmSessionCommandRequest::from_plan(
            ScmSessionCommandId("scm-command:1".to_owned()),
            ScmSessionCommandKind::IntegrateSession,
            ScmCapability::IntegrateWorkSession,
            ScmSessionCommandScope::IntegrationPreparation,
            session.clone(),
        );
        let admission = ScmSessionCommandAdmission::from_supported_capabilities(
            &command,
            &[ScmCapability::IntegrateWorkSession],
        );
        let link = EngineScmWorkItemLinkRecord {
            link_id: EngineScmWorkItemLinkId("link:1".to_owned()),
            task_id: TaskId("task:1".to_owned()),
            work_item_id: EngineTaskWorkItemId("work:1".to_owned()),
            work_session_id: session.id.clone(),
            session_command_ids: vec![command.id.clone()],
            change_refs: vec![ScmChangeRef {
                repository_id: session.repository_id.clone(),
                kind: ScmChangeKind::Snapshot,
                provider_ref: ScmProviderRef("snapshot:1".to_owned()),
                summary: None,
            }],
            checkpoint_ids: vec![EngineCheckpointRecordId("checkpoint:1".to_owned())],
            diff_summary_ids: vec![EngineDiffSummaryRecordId("diff:1".to_owned())],
            receipt_ids: Vec::new(),
            state: EngineScmWorkItemLinkState::Linked,
            summary: None,
        };

        let diagnostics = scm_session_diagnostics(&[session], &[admission], &[link]);
        let json = serde_json::to_string(&diagnostics).expect("serialize scm diagnostics");

        assert!(!diagnostics.client_can_mutate_working_copy);
        assert_eq!(diagnostics.source_status, "records");
        assert_eq!(diagnostics.sessions[0].mode, "isolated_location");
        assert_eq!(
            diagnostics.admissions[0].status,
            format!("{:?}", ScmSessionCommandAdmissionStatus::RequiresApproval)
        );
        assert_eq!(
            diagnostics.work_item_links[0].session_command_ids,
            vec!["scm-command:1".to_owned()]
        );
        assert!(!json.contains("pull_request"));
    }

    #[test]
    fn diagnostics_dtos_serialize_without_authority_drift() {
        let diagnostics = ScmSessionDiagnosticsDto {
            sessions: Vec::new(),
            admissions: Vec::new(),
            work_item_links: Vec::new(),
            client_can_mutate_working_copy: false,
            source_status: "empty".to_owned(),
            source_summary: Some("scm session source records are not persisted yet".to_owned()),
        };
        let json = serde_json::to_string(&diagnostics).expect("serialize diagnostics");

        assert!(json.contains("client_can_mutate_working_copy"));
        assert!(json.contains("source_status"));
        assert!(!json.contains("raw_stdout"));
        assert!(!json.contains("provider payload"));
    }
}
