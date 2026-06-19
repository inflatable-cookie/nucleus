use super::*;
use crate::{EngineScmWorkItemLinkId, EngineScmWorkItemLinkRecord, EngineScmWorkItemLinkState};
use nucleus_scm_forge::{
    ScmChangeKind, ScmChangeRef, ScmProviderRef, ScmRepositoryRefId, ScmSessionCommandId,
    ScmWorkSessionId,
};
use nucleus_tasks::TaskId;

use crate::{
    EngineCheckpointRecordId, EngineDiffSummaryRecordId, EngineRuntimeReceiptRecordId,
    EngineTaskWorkItemId,
};

fn change_ref(kind: ScmChangeKind, provider_ref: &str) -> ScmChangeRef {
    ScmChangeRef {
        repository_id: ScmRepositoryRefId("repo:nucleus".to_owned()),
        kind,
        provider_ref: ScmProviderRef(provider_ref.to_owned()),
        summary: Some("captured change".to_owned()),
    }
}

fn scm_link(change_ref: ScmChangeRef) -> EngineScmWorkItemLinkRecord {
    EngineScmWorkItemLinkRecord {
        link_id: EngineScmWorkItemLinkId("link:1".to_owned()),
        task_id: TaskId("task:1".to_owned()),
        work_item_id: EngineTaskWorkItemId("work:1".to_owned()),
        work_session_id: ScmWorkSessionId("session:scm".to_owned()),
        session_command_ids: vec![ScmSessionCommandId("scm-command:1".to_owned())],
        change_refs: vec![change_ref],
        checkpoint_ids: vec![EngineCheckpointRecordId("checkpoint:1".to_owned())],
        diff_summary_ids: vec![EngineDiffSummaryRecordId("diff:1".to_owned())],
        receipt_ids: vec![EngineRuntimeReceiptRecordId("receipt:1".to_owned())],
        state: EngineScmWorkItemLinkState::Linked,
        summary: Some("ready for handoff prep".to_owned()),
    }
}

#[test]
fn forge_review_prep_is_distinct_from_publication() {
    let prep = EngineChangeRequestPrepRecord::from_scm_link(
        EngineChangeRequestPrepId("prep:github".to_owned()),
        &scm_link(change_ref(ScmChangeKind::Commit, "git:commit:abc123")),
        EngineChangeRequestTarget::ForgeReview {
            provider: nucleus_scm_forge::ForgeProviderKind::GitHub,
            target_branch: None,
        },
        EngineChangeRequestReviewPolicy::HumanReviewRequired,
    );

    assert!(prep.is_prep_only());
    assert_eq!(
        prep.publication,
        EngineChangeRequestPublicationState::NotRequested
    );
    assert_eq!(
        prep.diff_summary_ids,
        vec![EngineDiffSummaryRecordId("diff:1".to_owned())]
    );
    assert!(prep.targets_github_review());
}

#[test]
fn convergence_style_publication_target_remains_viable() {
    let prep = EngineChangeRequestPrepRecord::from_scm_link(
        EngineChangeRequestPrepId("prep:convergence".to_owned()),
        &scm_link(change_ref(
            ScmChangeKind::Snapshot,
            "convergence:snapshot:abc123",
        )),
        EngineChangeRequestTarget::ProviderPublication {
            publication_ref: Some("convergence:publication:draft".to_owned()),
            gate_ref: Some("convergence:gate:review".to_owned()),
        },
        EngineChangeRequestReviewPolicy::StewardMayPrepareOnly,
    );

    assert!(prep.is_prep_only());
    assert!(prep.preserves_non_git_target());
    assert_eq!(prep.change_refs[0].kind, ScmChangeKind::Snapshot);
}

#[test]
fn prep_record_keeps_pr_shape_out_of_storage_model() {
    let prep = EngineChangeRequestPrepRecord::from_scm_link(
        EngineChangeRequestPrepId("prep:manual".to_owned()),
        &scm_link(change_ref(ScmChangeKind::Patch, "patch:series:1")),
        EngineChangeRequestTarget::ManualHandoff,
        EngineChangeRequestReviewPolicy::HumanReviewRequired,
    );

    assert!(prep.preserves_non_git_target());
    assert_eq!(prep.work_item_id, EngineTaskWorkItemId("work:1".to_owned()));
    assert_eq!(
        prep.checkpoint_ids,
        vec![EngineCheckpointRecordId("checkpoint:1".to_owned())]
    );
    assert!(matches!(
        prep.target,
        EngineChangeRequestTarget::ManualHandoff
    ));
}

#[test]
fn change_request_candidate_admission_requires_evidence_without_network_access() {
    let candidate = candidate_record();
    let admission = candidate.admit();

    assert!(admission.is_accepted());
    assert!(!admission.provider_network_allowed);
    assert_eq!(admission.evidence_refs.len(), 3);
}

#[test]
fn change_request_candidate_blocks_missing_evidence_or_policy_gates() {
    let mut missing_evidence = candidate_record();
    missing_evidence.evidence_refs.clear();
    let missing_admission = missing_evidence.admit();

    assert!(!missing_admission.is_accepted());

    let mut blocked = candidate_record();
    blocked
        .policy_gates
        .push(EngineChangeRequestPolicyGate::Blocked(
            "validation failed".to_owned(),
        ));
    let blocked_admission = blocked.admit();

    assert!(matches!(
        missing_admission.status,
        EngineChangeRequestCandidateAdmissionStatus::Blocked(_)
    ));
    assert!(matches!(
        blocked_admission.status,
        EngineChangeRequestCandidateAdmissionStatus::Blocked(_)
    ));
    assert!(!blocked_admission.provider_network_allowed);
}

#[test]
fn github_review_boundary_descriptor_stays_provider_specific() {
    let candidate = candidate_record();
    let descriptor =
        EngineGitHubReviewBoundaryDescriptor::from_candidate(&candidate).expect("github descriptor");

    assert_eq!(
        descriptor.provider,
        nucleus_scm_forge::ForgeProviderKind::GitHub
    );
    assert_eq!(descriptor.provider_label, "pull_request");
    assert_eq!(descriptor.required_refs, candidate.evidence_refs);
    assert!(!descriptor.network_call_allowed);

    let mut manual = candidate;
    manual.target = EngineChangeRequestTarget::ManualHandoff;
    assert!(EngineGitHubReviewBoundaryDescriptor::from_candidate(&manual).is_none());
}

#[test]
fn evidence_package_exposes_review_readiness_without_provider_authority() {
    let candidate = candidate_record();
    let package = EngineChangeRequestEvidencePackage::from_candidate(&candidate);

    assert!(package.is_review_ready());
    assert!(!package.client_can_mutate_provider);
    assert_eq!(package.capture_refs, vec!["capture-prep:1".to_owned()]);
    assert_eq!(
        package.work_session_refs,
        vec![ScmWorkSessionId("session:scm".to_owned())]
    );
    assert_eq!(package.status_diff_summary_refs.len(), 2);
    assert_eq!(package.validation_summary_refs.len(), 1);
}

fn candidate_record() -> EngineChangeRequestCandidateRecord {
    EngineChangeRequestCandidateRecord {
        candidate_id: EngineChangeRequestCandidateId("candidate:1".to_owned()),
        title: "Prepare management sync review".to_owned(),
        summary: "Review captured management projection changes".to_owned(),
        target: EngineChangeRequestTarget::ForgeReview {
            provider: nucleus_scm_forge::ForgeProviderKind::GitHub,
            target_branch: None,
        },
        evidence_refs: vec![
            EngineChangeRequestEvidenceRef("evidence:git-status".to_owned()),
            EngineChangeRequestEvidenceRef("evidence:diff-summary".to_owned()),
            EngineChangeRequestEvidenceRef("evidence:validation-summary".to_owned()),
        ],
        capture_refs: vec!["capture-prep:1".to_owned()],
        work_session_refs: vec![ScmWorkSessionId("session:scm".to_owned())],
        policy_gates: vec![
            EngineChangeRequestPolicyGate::CaptureEvidenceReviewed,
            EngineChangeRequestPolicyGate::WorkingSessionReviewed,
            EngineChangeRequestPolicyGate::ValidationReviewed,
            EngineChangeRequestPolicyGate::HumanReviewRequired,
        ],
        status: EngineChangeRequestCandidateStatus::ReadyForReview,
    }
}
