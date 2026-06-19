use super::*;

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
        status: nucleus_engine::ManagementProjectionCapturePrepStatus::Draft,
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
fn management_capture_review_model_exposes_readiness_without_provider_mutation() {
    let command = ManagementProjectionCaptureCommand {
        command_id: ManagementProjectionCaptureCommandId("capture-command:1".to_owned()),
        actor_ref: "actor:steward".to_owned(),
        target_project_id: ProjectId("project:nucleus".to_owned()),
        repo_membership_id: Some(RepoMembershipId("repo:nucleus".to_owned())),
        repository_id: Some(ScmRepositoryRefId("scm-repo:nucleus".to_owned())),
        projection_root: nucleus_engine::ManagementProjectionRoot::default(),
        requested_file_refs: vec![ManagementProjectionFileRef::task("task:1")],
        reason: ManagementProjectionCaptureReason::AppliedManagementProjection,
        scope: ManagementProjectionCaptureScope::ManagementProjection,
        policy_gates: vec![
            ManagementProjectionCapturePolicyGate::ProjectionApplied,
            ManagementProjectionCapturePolicyGate::EvidenceSanitized,
        ],
        evidence: ManagementProjectionCaptureEvidence {
            projection_file_refs: vec![ManagementProjectionFileRef::task("task:1")],
            apply_receipt_ids: vec![EngineRuntimeReceiptRecordId(
                "receipt:management-projection-apply:task:1:accepted".to_owned(),
            )],
            review_summary_refs: vec!["sync-review:1".to_owned()],
            validation_report_refs: vec!["validation:1".to_owned()],
            blocked_reasons: Vec::new(),
        },
    };
    let admission = command.admit();
    let prep = ManagementProjectionCapturePrepRecord::from_admitted_command(
        ManagementProjectionCapturePrepId("capture-prep:1".to_owned()),
        &command,
        &admission,
    );
    let review = management_capture_review_model(&[prep], &[admission]);
    let json = serde_json::to_string(&review).expect("serialize capture review");

    assert!(!review.client_can_mutate);
    assert!(!review.client_can_mutate_provider);
    assert_eq!(review.source_status, "records");
    assert_eq!(
        review.capture_preps[0].share_readiness,
        "ReadyForReviewBoundary"
    );
    assert_eq!(
        review.capture_preps[0].next_actions,
        vec!["review_capture_evidence".to_owned()]
    );
    assert!(!review.admissions[0].provider_mutation_allowed);
    for forbidden in [
        "raw_stdout",
        "raw_stderr",
        "provider_auth",
        "push",
        "pull request",
        "secret",
    ] {
        assert!(
            !json.contains(forbidden),
            "capture review leaked {forbidden}"
        );
    }
}

#[test]
fn management_sync_review_model_exposes_apply_review_state_without_raw_payloads() {
    let file_ref = ManagementProjectionFileRef::task("task:1");
    let staged = ManagementProjectionStagedFile {
        file_ref: file_ref.clone(),
        path: "repo/nucleus/tasks/task:1.toml".into(),
        document: ManagementProjectionFileDocument {
            envelope: ManagementProjectionEnvelope {
                schema_version: ManagementProjectionSchemaVersion::current(),
                record_id: ManagementProjectionRecordId("task:1".to_owned()),
                record_kind: ManagementProjectionRecordKind::Task,
                file_ref: file_ref.clone(),
            },
            payload: ManagementProjectionPayload::Unsupported {
                payload_kind: "task".to_owned(),
                retained_payload: "raw task payload should not appear".to_owned(),
            },
        },
        validation: ManagementProjectionValidationReport {
            file_ref: file_ref.clone(),
            record_id: Some(ManagementProjectionRecordId("task:1".to_owned())),
            status: ManagementProjectionValidationStatus::Valid,
            issues: Vec::new(),
        },
    };
    let conflict = ManagementProjectionConflictReport {
        conflict_id: "conflict:task:1".to_owned(),
        file_ref: file_ref.clone(),
        local_record_ref: Some(ManagementProjectionRecordId("task:1".to_owned())),
        incoming_record_ref: Some(ManagementProjectionRecordId("task:1".to_owned())),
        class: ManagementProjectionConflictClass::Semantic(
            ManagementProjectionSemanticConflictKind::AcceptanceCriteriaRewrite,
        ),
        summary: "acceptance criteria differ".to_owned(),
    };
    let receipt = EngineRuntimeReceiptRecord {
        receipt_id: EngineRuntimeReceiptRecordId(
            "receipt:management-projection-apply:task:1:blocked".to_owned(),
        ),
        family: EngineRuntimeReceiptEffectFamily::Custom("management_projection_apply".to_owned()),
        status: EngineRuntimeReceiptStatus::WaitingForApproval,
        command_ref: None,
        effect_ref: Some(EngineRuntimeReceiptRef::Custom(
            "management_projection_apply".to_owned(),
        )),
        evidence_refs: vec![EngineRuntimeReceiptRef::Custom(
            "conflict:conflict:task:1".to_owned(),
        )],
        artifact_refs: Vec::new(),
        summary: Some("blocked management projection apply".to_owned()),
    };
    let apply = ManagementProjectionImportApplyReport {
        applied: vec![ManagementProjectionAppliedRecord {
            record_id: ManagementProjectionRecordId("task:2".to_owned()),
            file_ref: ManagementProjectionFileRef::task("task:2"),
            revision_id: nucleus_core::RevisionId("rev:projection-apply:task:2".to_owned()),
            receipt_id: EngineRuntimeReceiptRecordId(
                "receipt:management-projection-apply:task:2:accepted".to_owned(),
            ),
            summary: "applied task projection record".to_owned(),
        }],
        blocked: vec![ManagementProjectionApplyBlock {
            record_id: Some(ManagementProjectionRecordId("task:1".to_owned())),
            file_ref: file_ref.clone(),
            kind: ManagementProjectionApplyBlockKind::SemanticConflict,
            summary: "semantic conflict requires review".to_owned(),
            conflict: Some(conflict.clone()),
            receipt_id: Some(receipt.receipt_id.clone()),
        }],
        receipts: vec![receipt.clone()],
        authoritative_state_mutated: false,
        scm_mutation_performed: false,
    };
    let staging = ManagementProjectionImportStagingReport {
        repo_root: "repo".into(),
        staged: vec![staged],
        invalid: Vec::new(),
        unsupported: Vec::new(),
        authoritative_state_mutated: false,
    };

    let review = management_sync_review_model(Some(&staging), Some(&apply), &[conflict], &[], &[]);
    let json = serde_json::to_string(&review).expect("serialize sync review model");

    assert!(!review.client_can_mutate);
    assert!(!review.client_can_mutate_provider);
    assert_eq!(review.staged_records.len(), 1);
    assert_eq!(review.applied_records.len(), 1);
    assert_eq!(review.blocked_records[0].kind, "SemanticConflict");
    assert_eq!(review.conflicts[0].class, "semantic");
    assert!(review.conflicts[0].requires_human_review);
    assert_eq!(review.receipts[0].status, "WaitingForApproval");
    for forbidden in [
        "raw task payload",
        "provider_auth",
        "raw_stdout",
        "secret",
        "push",
    ] {
        assert!(!json.contains(forbidden), "review model leaked {forbidden}");
    }
}
