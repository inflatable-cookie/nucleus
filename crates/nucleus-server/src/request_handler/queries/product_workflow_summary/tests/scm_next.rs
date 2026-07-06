use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{LocalStoreRecord, LocalStoreRecordPayload, RevisionExpectation};
use nucleus_projects::ProjectId;

use super::super::*;
use super::support::{handler, handler_with_project_task};
use crate::{
    ProductWorkflowGapArea, ProductWorkflowNextStepSource, ScmCaptureReviewDecision,
    ScmCaptureReviewDecisionPersistenceStatus, ScmCaptureReviewDecisionRecord,
    ScmCaptureReviewReadinessStatus,
};

#[test]
fn product_workflow_summary_query_composes_scm_readiness_refs_without_effects() {
    let (_temp_dir, handler) = handler_with_project_task();
    seed_scm_review_decision(&handler);

    let result = product_workflow_summary_query(
        &handler,
        ProductWorkflowSummaryQuery {
            project_id: ProjectId("project:nucleus-local".to_owned()),
        },
    )
    .expect("product workflow summary");

    let ServerQueryResult::ProductWorkflowSummary(summary) = result else {
        panic!("expected product workflow summary result");
    };

    assert_eq!(summary.source_counts.scm_readiness_refs, 2);
    assert_eq!(
        summary.scm_readiness.readiness_refs,
        vec![
            "scm-capture-review-decision:nucleus-local".to_owned(),
            "scm-capture-review-readiness:nucleus-local".to_owned(),
        ]
    );
    assert!(summary
        .gaps
        .iter()
        .all(|gap| gap.area != ProductWorkflowGapArea::ScmReadiness));
    assert_eq!(summary.next.source, ProductWorkflowNextStepSource::Task);
    assert!(!summary.no_effects.scm_or_forge_mutation_performed);
    assert!(!summary.no_effects.provider_write_performed);
    assert!(!summary.no_effects.agent_scheduling_performed);
}

#[test]
fn product_workflow_summary_query_keeps_next_blocked_when_no_pathway_exists() {
    let (_temp_dir, handler) = handler();

    let result = product_workflow_summary_query(
        &handler,
        ProductWorkflowSummaryQuery {
            project_id: ProjectId("project:nucleus-local".to_owned()),
        },
    )
    .expect("product workflow summary");

    let ServerQueryResult::ProductWorkflowSummary(summary) = result else {
        panic!("expected product workflow summary result");
    };

    assert_eq!(
        summary.next.source,
        ProductWorkflowNextStepSource::BlockedByMissingPathway
    );
    assert!(summary
        .gaps
        .iter()
        .any(|gap| gap.area == ProductWorkflowGapArea::Next));
    assert_eq!(summary.source_counts.scm_readiness_refs, 0);
    assert!(!summary.no_effects.task_mutation_performed);
    assert!(!summary.no_effects.scm_or_forge_mutation_performed);
}

fn seed_scm_review_decision(
    handler: &crate::request_handler::LocalControlRequestHandler<
        nucleus_local_store::SqliteBackend,
    >,
) {
    let record = ScmCaptureReviewDecisionRecord {
        decision_id: "scm-capture-review-decision:nucleus-local".to_owned(),
        readiness_id: "scm-capture-review-readiness:nucleus-local".to_owned(),
        workflow_id: "scm-capture-workflow:nucleus-local".to_owned(),
        task_id: "task:nucleus-local:bootstrap".to_owned(),
        work_item_id: Some("work:nucleus-local".to_owned()),
        completion_id: Some("completion:nucleus-local".to_owned()),
        repo_id: "repo:nucleus-local".to_owned(),
        operator_ref: "operator:tom".to_owned(),
        decision: ScmCaptureReviewDecision::Accept,
        evidence_refs: vec!["evidence:scm:nucleus-local".to_owned()],
        readiness_status: ScmCaptureReviewReadinessStatus::Ready,
        status: ScmCaptureReviewDecisionPersistenceStatus::Persisted,
        blockers: Vec::new(),
        duplicate_decision_detected: false,
        change_request_authority_granted: false,
        scm_mutation_authority_granted: false,
        forge_authority_granted: false,
        provider_authority_granted: false,
        callback_authority_granted: false,
        interruption_authority_granted: false,
        recovery_authority_granted: false,
        raw_output_retained: false,
    };

    handler
        .state()
        .artifact_metadata()
        .put(
            LocalStoreRecord {
                id: PersistenceRecordId(record.decision_id.clone()),
                domain: PersistenceDomain::ArtifactMetadata,
                kind: PersistenceRecordKind::ArtifactMetadata,
                revision_id: RevisionId("rev:scm-review-decision:nucleus-local".to_owned()),
                payload: LocalStoreRecordPayload {
                    media_type: Some("application/json".to_owned()),
                    bytes: serde_json::to_vec(&record).expect("encode scm review decision"),
                },
            },
            RevisionExpectation::MustNotExist,
        )
        .expect("put scm review decision");
}
