use crate::tools::{NativeRuntimeReceiptRef, NativeToolActionId};

use super::proposals::NativeStewardProposalId;
use super::records::{NativeStewardEvidenceRef, NativeStewardProposalReview};
use super::safety::contains_forbidden_steward_term;

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

/// Stable steward sync decision id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct NativeStewardSyncDecisionId(pub String);

/// Steward decision over management sync and SCM preparation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeStewardSyncDecisionRecord {
    pub id: NativeStewardSyncDecisionId,
    pub assistance_id: Option<NativeStewardSyncAssistanceId>,
    pub kind: NativeStewardSyncDecisionKind,
    pub confidence: NativeStewardSyncDecisionConfidence,
    pub evidence_refs: Vec<NativeStewardEvidenceRef>,
    pub requested_next_action: NativeStewardSyncNextAction,
    pub blocked_reasons: Vec<String>,
    pub provider_mutation_allowed: bool,
    pub summary: Option<String>,
}

impl NativeStewardSyncDecisionRecord {
    pub fn recommendation(
        id: NativeStewardSyncDecisionId,
        assistance: &NativeStewardSyncAssistance,
        requested_next_action: NativeStewardSyncNextAction,
    ) -> Self {
        Self {
            id,
            assistance_id: Some(assistance.id.clone()),
            kind: NativeStewardSyncDecisionKind::Recommendation,
            confidence: NativeStewardSyncDecisionConfidence::Medium,
            evidence_refs: assistance.evidence_refs.clone(),
            requested_next_action,
            blocked_reasons: Vec::new(),
            provider_mutation_allowed: false,
            summary: assistance.summary.clone(),
        }
    }

    pub fn blocked(
        id: NativeStewardSyncDecisionId,
        assistance: &NativeStewardSyncAssistance,
        reason: String,
    ) -> Self {
        Self {
            id,
            assistance_id: Some(assistance.id.clone()),
            kind: NativeStewardSyncDecisionKind::Blocked,
            confidence: NativeStewardSyncDecisionConfidence::Low,
            evidence_refs: assistance.evidence_refs.clone(),
            requested_next_action: NativeStewardSyncNextAction::RequestHumanReview,
            blocked_reasons: vec![reason],
            provider_mutation_allowed: false,
            summary: assistance.summary.clone(),
        }
    }

    pub fn is_advisory_only(&self) -> bool {
        !self.provider_mutation_allowed
            && self
                .blocked_reasons
                .iter()
                .all(|reason| !contains_forbidden_steward_term(reason))
            && self
                .summary
                .as_ref()
                .map(|summary| !contains_forbidden_steward_term(summary))
                .unwrap_or(true)
            && self
                .evidence_refs
                .iter()
                .all(NativeStewardEvidenceRef::uses_reference_only_evidence)
    }
}

/// Steward sync decision kind.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeStewardSyncDecisionKind {
    Recommendation,
    Blocked,
    ReviewRequired,
    NoAction,
}

/// Coarse confidence for steward sync recommendations.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeStewardSyncDecisionConfidence {
    Low,
    Medium,
    High,
}

/// Next action requested by a steward sync decision.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeStewardSyncNextAction {
    ReviewCaptureEvidence,
    PrepareManagementCapture,
    PrepareChangeRequest,
    RequestHumanReview,
    ProviderMutationOutOfScope,
}
