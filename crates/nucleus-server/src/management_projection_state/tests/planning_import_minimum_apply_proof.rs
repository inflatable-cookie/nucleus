use super::*;
use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_engine::{
    EngineRuntimeReceiptRecordId, ManagementProjectionEnvelope, ManagementProjectionFileDocument,
    ManagementProjectionFileRef, ManagementProjectionPayload,
    ManagementProjectionPlanningArtifactBody, ManagementProjectionPlanningArtifactKind,
    ManagementProjectionPlanningArtifactRecord, ManagementProjectionPlanningArtifactStatus,
    ManagementProjectionPlanningReviewState, ManagementProjectionRecordId,
    ManagementProjectionRecordKind, ManagementProjectionSchemaVersion,
};
use nucleus_local_store::{LocalStoreRecord, LocalStoreRecordPayload, RevisionExpectation};

#[test]
fn minimum_planning_import_apply_proof_updates_one_existing_artifact() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
    seed_existing_artifact(&state, "artifact:roadmap", "revision:expected");

    let receipt = apply_minimum_planning_projection_import_proof(
        &state,
        proof_request(executor_plan("artifact:roadmap", "revision:expected")),
    )
    .expect("apply proof");

    assert_eq!(
        receipt.status,
        PlanningProjectionImportMinimumApplyProofStatus::Applied
    );
    assert!(receipt.blockers.is_empty());
    assert!(receipt.active_planning_mutation_performed);
    assert_no_unrelated_effects(&receipt);
    assert!(receipt
        .evidence_refs
        .contains(&"sanitization:planning-import-proof".to_owned()));

    let updated = state
        .planning()
        .get(&PersistenceRecordId("artifact:roadmap".to_owned()))
        .expect("get artifact")
        .expect("artifact exists");
    assert_eq!(updated.kind, PersistenceRecordKind::PlanningArtifact);
    assert_eq!(updated.revision_id, RevisionId("revision:next".to_owned()));

    let receipts = read_runtime_receipts(&state).expect("read receipts");
    assert_eq!(receipts.len(), 1);
    assert_eq!(
        receipts[0].receipt_id,
        EngineRuntimeReceiptRecordId("receipt:planning-import-proof:artifact:roadmap".to_owned())
    );
}

#[test]
fn minimum_planning_import_apply_proof_blocks_stale_revision_without_mutation() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
    seed_existing_artifact(&state, "artifact:roadmap", "revision:newer");

    let receipt = apply_minimum_planning_projection_import_proof(
        &state,
        proof_request(executor_plan("artifact:roadmap", "revision:expected")),
    )
    .expect("blocked proof");

    assert_eq!(
        receipt.status,
        PlanningProjectionImportMinimumApplyProofStatus::Blocked
    );
    assert!(receipt.blockers.contains(
        &PlanningProjectionImportMinimumApplyProofBlocker::TargetRevisionConflict {
            expected: "revision:expected".to_owned(),
            observed: "revision:newer".to_owned()
        }
    ));
    assert!(!receipt.active_planning_mutation_performed);
    assert_no_unrelated_effects(&receipt);

    let unchanged = state
        .planning()
        .get(&PersistenceRecordId("artifact:roadmap".to_owned()))
        .expect("get artifact")
        .expect("artifact exists");
    assert_eq!(
        unchanged.revision_id,
        RevisionId("revision:newer".to_owned())
    );
}

#[test]
fn minimum_planning_import_apply_proof_blocks_widened_executor_authority() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
    seed_existing_artifact(&state, "artifact:roadmap", "revision:expected");
    let mut plan = executor_plan("artifact:roadmap", "revision:expected");
    plan.provider_execution_permitted = true;

    let receipt = apply_minimum_planning_projection_import_proof(&state, proof_request(plan))
        .expect("blocked proof");

    assert_eq!(
        receipt.status,
        PlanningProjectionImportMinimumApplyProofStatus::Blocked
    );
    assert!(receipt.blockers.contains(
        &PlanningProjectionImportMinimumApplyProofBlocker::EffectPermissionWidened {
            effect: "provider_execution".to_owned()
        }
    ));
    assert!(!receipt.active_planning_mutation_performed);
    assert_no_unrelated_effects(&receipt);
}

fn proof_request(
    executor_plan: PlanningProjectionImportActiveApplyExecutorPlan,
) -> PlanningProjectionImportMinimumApplyProofRequest {
    PlanningProjectionImportMinimumApplyProofRequest {
        executor_plan,
        reviewed_document: planning_artifact_document("artifact:roadmap"),
        next_revision_id: RevisionId("revision:next".to_owned()),
        receipt_id: EngineRuntimeReceiptRecordId(
            "receipt:planning-import-proof:artifact:roadmap".to_owned(),
        ),
        sanitization_policy_ref: "sanitization:planning-import-proof".to_owned(),
    }
}

fn executor_plan(
    record_id: &str,
    revision: &str,
) -> PlanningProjectionImportActiveApplyExecutorPlan {
    PlanningProjectionImportActiveApplyExecutorPlan {
        executor_plan_id: "planning-import-active-apply-executor:proof".to_owned(),
        admission_record_id: Some("planning-import-active-apply-admission:proof".to_owned()),
        stopped_apply_record_id: Some("planning-import-apply-plan:proof".to_owned()),
        dry_run_apply_plan_id: Some("planning-import-apply-plan:proof".to_owned()),
        operator_ref: Some("operator:tom".to_owned()),
        approval_ref: Some("approval:accepted".to_owned()),
        status: PlanningProjectionImportActiveApplyExecutorStatus::PlannedStopped,
        blockers: Vec::new(),
        operation_plans: vec![PlanningProjectionImportActiveApplyExecutorOperationPlan {
            operation_plan_id: "operation-plan:artifact".to_owned(),
            source_operation_id: "operation:artifact".to_owned(),
            record_id: record_id.to_owned(),
            file_ref: "nucleus/planning/artifact:roadmap.toml".to_owned(),
            operation_kind: "apply_planning_artifact".to_owned(),
            expected_current_revision: Some(revision.to_owned()),
            observed_current_revision: Some(revision.to_owned()),
            revision_expectation_ref: Some(format!("revision-expectation:{revision}")),
            evidence_refs: vec![
                "review:accepted".to_owned(),
                "management-file-ref:nucleus/planning/artifact:roadmap.toml".to_owned(),
            ],
            active_planning_mutation_permitted: false,
        }],
        planned_receipts: Vec::new(),
        evidence_refs: vec!["executor-plan:proof".to_owned()],
        executor_planned: true,
        duplicate_executor_plan_detected: false,
        active_planning_mutation_permitted: false,
        final_mutation_receipt_permitted: false,
        task_creation_permitted: false,
        task_promotion_permitted: false,
        projection_write_permitted: false,
        agent_scheduling_permitted: false,
        provider_execution_permitted: false,
        scm_mutation_permitted: false,
        forge_mutation_permitted: false,
        semantic_merge_permitted: false,
        accepted_memory_mutation_permitted: false,
        callback_permitted: false,
        interruption_permitted: false,
        recovery_permitted: false,
        raw_payload_retained: false,
        payload_body_included: false,
        ui_apply_permitted: false,
    }
}

fn seed_existing_artifact(
    state: &ServerStateService<SqliteBackend>,
    record_id: &str,
    revision: &str,
) {
    state
        .planning()
        .put(
            LocalStoreRecord {
                id: PersistenceRecordId(record_id.to_owned()),
                domain: PersistenceDomain::Planning,
                kind: PersistenceRecordKind::PlanningArtifact,
                revision_id: RevisionId(revision.to_owned()),
                payload: LocalStoreRecordPayload {
                    media_type: Some("application/json".to_owned()),
                    bytes: br#"{"artifact_id":"artifact:roadmap"}"#.to_vec(),
                },
            },
            RevisionExpectation::MustNotExist,
        )
        .expect("seed artifact");
}

fn planning_artifact_document(record_id: &str) -> ManagementProjectionFileDocument {
    ManagementProjectionFileDocument {
        envelope: ManagementProjectionEnvelope {
            schema_version: ManagementProjectionSchemaVersion::current(),
            record_id: ManagementProjectionRecordId(record_id.to_owned()),
            record_kind: ManagementProjectionRecordKind::PlanningArtifact,
            file_ref: ManagementProjectionFileRef(
                "nucleus/planning/artifact:roadmap.toml".to_owned(),
            ),
        },
        payload: ManagementProjectionPayload::PlanningArtifact(
            ManagementProjectionPlanningArtifactRecord {
                artifact_id: record_id.to_owned(),
                project_id: "project:nucleus".to_owned(),
                artifact_kind: ManagementProjectionPlanningArtifactKind::RoadmapOutline,
                title: "Roadmap".to_owned(),
                body: ManagementProjectionPlanningArtifactBody::Text(
                    "Reviewed planning content.".to_owned(),
                ),
                status: ManagementProjectionPlanningArtifactStatus::Accepted,
                source_planning_session_ref: Some("planning-session:proof".to_owned()),
                source_research_run_refs: Vec::new(),
                source_memory_refs: Vec::new(),
                supersedes: Vec::new(),
                superseded_by: Vec::new(),
                projection_ref: Some("nucleus/planning/artifact:roadmap.toml".to_owned()),
                review: ManagementProjectionPlanningReviewState::Accepted {
                    reviewer_ref: "operator:tom".to_owned(),
                },
            },
        ),
    }
}

fn assert_no_unrelated_effects(receipt: &PlanningProjectionImportMinimumApplyProofReceipt) {
    assert!(!receipt.task_creation_performed);
    assert!(!receipt.task_promotion_performed);
    assert!(!receipt.provider_execution_performed);
    assert!(!receipt.scm_mutation_performed);
    assert!(!receipt.forge_mutation_performed);
    assert!(!receipt.accepted_memory_mutation_performed);
    assert!(!receipt.semantic_merge_performed);
    assert!(!receipt.raw_payload_retained);
    assert!(!receipt.ui_apply_triggered);
}
