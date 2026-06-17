//! Native steward proposal records.
//!
//! These records describe proposed task and project-organization hygiene work.
//! They do not apply task mutations, change assignment, or rewrite history.

use crate::personas::NativePersonaId;
use crate::tools::{NativeRuntimeReceiptRef, NativeToolActionId};

/// Stable steward proposal id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct NativeStewardProposalId(pub String);

/// Proposed steward hygiene change.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeStewardProposal {
    pub id: NativeStewardProposalId,
    pub persona_id: Option<NativePersonaId>,
    pub target: NativeStewardProposalTarget,
    pub kind: NativeStewardProposalKind,
    pub review: NativeStewardProposalReview,
    pub proposed_changes: Vec<NativeStewardProposedChange>,
    pub evidence_refs: Vec<NativeStewardEvidenceRef>,
    pub tool_action_id: Option<NativeToolActionId>,
    pub receipt_refs: Vec<NativeRuntimeReceiptRef>,
    pub summary: Option<String>,
}

impl NativeStewardProposal {
    pub fn is_pending_review(&self) -> bool {
        matches!(
            self.review,
            NativeStewardProposalReview::Draft
                | NativeStewardProposalReview::NeedsHumanApproval
                | NativeStewardProposalReview::NeedsPolicyApproval
        )
    }

    pub fn requires_human_approval(&self) -> bool {
        self.review == NativeStewardProposalReview::NeedsHumanApproval
            || self
                .proposed_changes
                .iter()
                .any(|change| change.semantic == NativeStewardChangeSemantic::Semantic)
    }

    pub fn uses_reference_only_evidence(&self) -> bool {
        self.summary
            .as_ref()
            .map(|summary| !contains_forbidden_steward_term(summary))
            .unwrap_or(true)
            && self
                .proposed_changes
                .iter()
                .all(NativeStewardProposedChange::uses_reference_only_evidence)
            && self
                .evidence_refs
                .iter()
                .all(NativeStewardEvidenceRef::uses_reference_only_evidence)
            && self
                .receipt_refs
                .iter()
                .all(|receipt_ref| !contains_forbidden_steward_term(&receipt_ref.0))
    }

    pub fn has_applied_mutation_state(&self) -> bool {
        false
    }
}

/// Steward assistance for management projection sync or SCM repair.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeStewardSyncAssistance {
    pub id: NativeStewardSyncAssistanceId,
    pub proposal_id: Option<NativeStewardProposalId>,
    pub kind: NativeStewardSyncAssistanceKind,
    pub review: NativeStewardProposalReview,
    pub links: NativeStewardSyncAssistanceLinks,
    pub capture_plan: Option<NativeStewardManagementCapturePlan>,
    pub evidence_refs: Vec<NativeStewardEvidenceRef>,
    pub tool_action_id: Option<NativeToolActionId>,
    pub receipt_refs: Vec<NativeRuntimeReceiptRef>,
    pub summary: Option<String>,
}

impl NativeStewardSyncAssistance {
    pub fn is_mechanical_assistance(&self) -> bool {
        matches!(
            self.kind,
            NativeStewardSyncAssistanceKind::MechanicalConflictRepair
        )
    }

    pub fn is_semantic_escalation(&self) -> bool {
        matches!(
            self.kind,
            NativeStewardSyncAssistanceKind::SemanticConflictEscalation
        )
    }

    pub fn is_prep_only(&self) -> bool {
        self.kind != NativeStewardSyncAssistanceKind::PublicationRequest
            && self
                .capture_plan
                .as_ref()
                .map(NativeStewardManagementCapturePlan::is_prep_only)
                .unwrap_or(true)
    }

    pub fn requires_human_approval(&self) -> bool {
        self.review == NativeStewardProposalReview::NeedsHumanApproval
            || self.is_semantic_escalation()
            || self.kind == NativeStewardSyncAssistanceKind::PublicationRequest
    }

    pub fn uses_reference_only_evidence(&self) -> bool {
        self.summary
            .as_ref()
            .map(|summary| !contains_forbidden_steward_term(summary))
            .unwrap_or(true)
            && self.links.uses_reference_only_evidence()
            && self
                .capture_plan
                .as_ref()
                .map(NativeStewardManagementCapturePlan::uses_reference_only_evidence)
                .unwrap_or(true)
            && self
                .evidence_refs
                .iter()
                .all(NativeStewardEvidenceRef::uses_reference_only_evidence)
            && self
                .receipt_refs
                .iter()
                .all(|receipt_ref| !contains_forbidden_steward_term(&receipt_ref.0))
    }
}

/// Stable sync-assistance id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct NativeStewardSyncAssistanceId(pub String);

/// Sync-assistance category.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeStewardSyncAssistanceKind {
    MechanicalConflictRepair,
    SemanticConflictEscalation,
    ManagementCapturePreparation,
    ChangeRequestPreparation,
    PublicationRequest,
    Custom(String),
}

/// Sync evidence and planning refs.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct NativeStewardSyncAssistanceLinks {
    pub projection_conflict_report_refs: Vec<String>,
    pub scm_work_session_refs: Vec<String>,
    pub change_request_prep_refs: Vec<String>,
    pub management_projection_refs: Vec<String>,
}

impl NativeStewardSyncAssistanceLinks {
    pub fn uses_reference_only_evidence(&self) -> bool {
        self.projection_conflict_report_refs
            .iter()
            .chain(self.scm_work_session_refs.iter())
            .chain(self.change_request_prep_refs.iter())
            .chain(self.management_projection_refs.iter())
            .all(|value| !contains_forbidden_steward_term(value))
    }
}

/// Management-state capture plan prepared by the steward.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeStewardManagementCapturePlan {
    pub plan_ref: String,
    pub status: NativeStewardManagementCapturePlanStatus,
    pub scope: NativeStewardManagementCaptureScope,
    pub summary: Option<String>,
}

impl NativeStewardManagementCapturePlan {
    pub fn is_prep_only(&self) -> bool {
        matches!(
            self.status,
            NativeStewardManagementCapturePlanStatus::Draft
                | NativeStewardManagementCapturePlanStatus::ReadyForApproval
                | NativeStewardManagementCapturePlanStatus::Blocked(_)
        )
    }

    pub fn uses_reference_only_evidence(&self) -> bool {
        !contains_forbidden_steward_term(&self.plan_ref)
            && self
                .summary
                .as_ref()
                .map(|summary| !contains_forbidden_steward_term(summary))
                .unwrap_or(true)
    }
}

/// Capture-plan state. Executed captures are out of scope for the steward
/// proposal surface.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeStewardManagementCapturePlanStatus {
    Draft,
    ReadyForApproval,
    Blocked(String),
    ExecutedOutOfScope,
}

/// Management capture scope.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeStewardManagementCaptureScope {
    ManagementProjection,
    TaskRecords,
    DocsIndexes,
    ProjectMetadata,
    Custom(String),
}

/// Proposal target.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeStewardProposalTarget {
    Project { project_ref: String },
    Task { task_ref: String },
    TaskSet { task_refs: Vec<String> },
    DocsIndex { index_ref: String },
    ManagementProjection { projection_ref: String },
    ProjectionConflict { conflict_report_ref: String },
    ScmWorkSession { work_session_ref: String },
    ChangeRequestPrep { prep_ref: String },
    Custom(String),
}

/// Proposal kind.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeStewardProposalKind {
    TaskMetadataNormalization,
    DuplicateTaskDetection,
    BlockedTaskFlag,
    StaleTaskFlag,
    ReadinessHint,
    DocumentationIndexUpdate,
    ProjectOrganizationHint,
    MechanicalSyncRepair,
    SemanticSyncEscalation,
    ManagementCapturePreparation,
    ChangeRequestPreparation,
    Custom(String),
}

/// Proposal review state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeStewardProposalReview {
    Draft,
    NeedsHumanApproval,
    NeedsPolicyApproval,
    AcceptedForLaterMutation,
    Rejected(String),
    Superseded(String),
}

/// One field-level proposed change.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeStewardProposedChange {
    pub field: NativeStewardChangeField,
    pub semantic: NativeStewardChangeSemantic,
    pub before_ref: Option<String>,
    pub after_ref: Option<String>,
    pub rationale: Option<String>,
}

impl NativeStewardProposedChange {
    pub fn uses_reference_only_evidence(&self) -> bool {
        self.before_ref
            .as_ref()
            .map(|value| !contains_forbidden_steward_term(value))
            .unwrap_or(true)
            && self
                .after_ref
                .as_ref()
                .map(|value| !contains_forbidden_steward_term(value))
                .unwrap_or(true)
            && self
                .rationale
                .as_ref()
                .map(|value| !contains_forbidden_steward_term(value))
                .unwrap_or(true)
    }
}

/// Field family named by a proposed change.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeStewardChangeField {
    Title,
    Description,
    AcceptanceCriteria,
    Importance,
    AgentReadiness,
    Blocker,
    Staleness,
    DuplicateLink,
    DocsIndexEntry,
    ProjectGrouping,
    ProjectionConflictResolution,
    ManagementCapturePlan,
    ChangeRequestPrep,
    Custom(String),
}

/// Whether a change is mechanical or meaning-changing.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeStewardChangeSemantic {
    Mechanical,
    Semantic,
}

/// Evidence supporting a steward proposal.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeStewardEvidenceRef {
    pub source: NativeStewardEvidenceSource,
    pub ref_id: String,
}

impl NativeStewardEvidenceRef {
    pub fn uses_reference_only_evidence(&self) -> bool {
        !contains_forbidden_steward_term(&self.ref_id)
    }
}

/// Source family for proposal evidence.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeStewardEvidenceSource {
    Effigy,
    Scm,
    ProjectionConflict,
    ScmWorkSession,
    ChangeRequestPrep,
    ManagementProjection,
    Validation,
    Task,
    Docs,
    RuntimeReceipt,
    Custom(String),
}

fn contains_forbidden_steward_term(value: &str) -> bool {
    [
        "raw_stdout",
        "raw_stderr",
        "terminal stream",
        "provider payload",
        "model raw output",
        "secret",
        "credential",
        "token",
    ]
    .iter()
    .any(|term| value.to_lowercase().contains(term))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proposal(kind: NativeStewardProposalKind) -> NativeStewardProposal {
        NativeStewardProposal {
            id: NativeStewardProposalId("proposal:1".to_owned()),
            persona_id: Some(NativePersonaId("persona:steward".to_owned())),
            target: NativeStewardProposalTarget::Task {
                task_ref: "task:1".to_owned(),
            },
            kind,
            review: NativeStewardProposalReview::Draft,
            proposed_changes: Vec::new(),
            evidence_refs: Vec::new(),
            tool_action_id: Some(NativeToolActionId("tool:steward:1".to_owned())),
            receipt_refs: vec![NativeRuntimeReceiptRef("receipt:steward:1".to_owned())],
            summary: Some("sanitized steward proposal".to_owned()),
        }
    }

    #[test]
    fn steward_proposal_kinds_cover_task_hygiene_and_docs_updates() {
        let kinds = vec![
            NativeStewardProposalKind::TaskMetadataNormalization,
            NativeStewardProposalKind::DuplicateTaskDetection,
            NativeStewardProposalKind::BlockedTaskFlag,
            NativeStewardProposalKind::StaleTaskFlag,
            NativeStewardProposalKind::ReadinessHint,
            NativeStewardProposalKind::DocumentationIndexUpdate,
        ];

        for kind in kinds {
            let proposal = proposal(kind);
            assert!(proposal.is_pending_review());
            assert!(!proposal.has_applied_mutation_state());
            assert!(proposal.uses_reference_only_evidence());
        }
    }

    #[test]
    fn steward_semantic_changes_require_human_approval() {
        let mut proposal = proposal(NativeStewardProposalKind::ReadinessHint);
        proposal.proposed_changes.push(NativeStewardProposedChange {
            field: NativeStewardChangeField::AgentReadiness,
            semantic: NativeStewardChangeSemantic::Semantic,
            before_ref: Some("task:1:readiness:before".to_owned()),
            after_ref: Some("task:1:readiness:after".to_owned()),
            rationale: Some("readiness changes alter task handoff behavior".to_owned()),
        });

        assert!(proposal.requires_human_approval());
        assert!(proposal.is_pending_review());
    }

    #[test]
    fn steward_proposals_can_cite_effigy_scm_validation_and_task_evidence() {
        let mut proposal = proposal(NativeStewardProposalKind::BlockedTaskFlag);
        proposal.evidence_refs = vec![
            NativeStewardEvidenceRef {
                source: NativeStewardEvidenceSource::Effigy,
                ref_id: "evidence:effigy:doctor".to_owned(),
            },
            NativeStewardEvidenceRef {
                source: NativeStewardEvidenceSource::Scm,
                ref_id: "evidence:scm:status".to_owned(),
            },
            NativeStewardEvidenceRef {
                source: NativeStewardEvidenceSource::Validation,
                ref_id: "evidence:validation:plan".to_owned(),
            },
            NativeStewardEvidenceRef {
                source: NativeStewardEvidenceSource::Task,
                ref_id: "task:1:history".to_owned(),
            },
        ];

        assert_eq!(proposal.evidence_refs.len(), 4);
        assert!(proposal.uses_reference_only_evidence());
    }

    #[test]
    fn steward_proposals_reject_raw_output_terms() {
        let mut proposal = proposal(NativeStewardProposalKind::TaskMetadataNormalization);
        proposal.summary = Some("contains raw_stdout".to_owned());

        assert!(!proposal.uses_reference_only_evidence());
    }

    fn sync_assistance(kind: NativeStewardSyncAssistanceKind) -> NativeStewardSyncAssistance {
        NativeStewardSyncAssistance {
            id: NativeStewardSyncAssistanceId("sync-assist:1".to_owned()),
            proposal_id: Some(NativeStewardProposalId("proposal:sync:1".to_owned())),
            kind,
            review: NativeStewardProposalReview::Draft,
            links: NativeStewardSyncAssistanceLinks {
                projection_conflict_report_refs: vec!["conflict:projection:1".to_owned()],
                scm_work_session_refs: vec!["scm-session:1".to_owned()],
                change_request_prep_refs: vec!["change-request-prep:1".to_owned()],
                management_projection_refs: vec!["projection:nucleus/tasks/task-1".to_owned()],
            },
            capture_plan: None,
            evidence_refs: vec![
                NativeStewardEvidenceRef {
                    source: NativeStewardEvidenceSource::ProjectionConflict,
                    ref_id: "conflict:projection:1".to_owned(),
                },
                NativeStewardEvidenceRef {
                    source: NativeStewardEvidenceSource::ScmWorkSession,
                    ref_id: "scm-session:1".to_owned(),
                },
                NativeStewardEvidenceRef {
                    source: NativeStewardEvidenceSource::ChangeRequestPrep,
                    ref_id: "change-request-prep:1".to_owned(),
                },
            ],
            tool_action_id: Some(NativeToolActionId("tool:sync-assist:1".to_owned())),
            receipt_refs: vec![NativeRuntimeReceiptRef("receipt:sync-assist:1".to_owned())],
            summary: Some("sanitized sync assistance".to_owned()),
        }
    }

    #[test]
    fn steward_sync_assistance_separates_mechanical_and_semantic_conflicts() {
        let mechanical = sync_assistance(NativeStewardSyncAssistanceKind::MechanicalConflictRepair);
        let semantic = sync_assistance(NativeStewardSyncAssistanceKind::SemanticConflictEscalation);

        assert!(mechanical.is_mechanical_assistance());
        assert!(!mechanical.requires_human_approval());
        assert!(mechanical.is_prep_only());
        assert!(semantic.is_semantic_escalation());
        assert!(semantic.requires_human_approval());
        assert!(semantic.is_prep_only());
    }

    #[test]
    fn steward_can_prepare_management_capture_plan_without_executing_it() {
        let mut assistance =
            sync_assistance(NativeStewardSyncAssistanceKind::ManagementCapturePreparation);
        assistance.capture_plan = Some(NativeStewardManagementCapturePlan {
            plan_ref: "capture-plan:management:1".to_owned(),
            status: NativeStewardManagementCapturePlanStatus::ReadyForApproval,
            scope: NativeStewardManagementCaptureScope::ManagementProjection,
            summary: Some("prepare management projection capture".to_owned()),
        });

        assert!(assistance.is_prep_only());
        assert!(assistance.uses_reference_only_evidence());
        assert!(assistance
            .capture_plan
            .as_ref()
            .expect("capture plan")
            .is_prep_only());
    }

    #[test]
    fn steward_change_request_assistance_stays_separate_from_publication() {
        let assistance = sync_assistance(NativeStewardSyncAssistanceKind::ChangeRequestPreparation);
        let publication = sync_assistance(NativeStewardSyncAssistanceKind::PublicationRequest);

        assert!(assistance.is_prep_only());
        assert!(!assistance.requires_human_approval());
        assert!(!publication.is_prep_only());
        assert!(publication.requires_human_approval());
    }

    #[test]
    fn steward_sync_assistance_rejects_raw_or_secret_refs() {
        let mut assistance =
            sync_assistance(NativeStewardSyncAssistanceKind::MechanicalConflictRepair);
        assistance.links.scm_work_session_refs = vec!["secret:session".to_owned()];

        assert!(!assistance.uses_reference_only_evidence());
    }
}
