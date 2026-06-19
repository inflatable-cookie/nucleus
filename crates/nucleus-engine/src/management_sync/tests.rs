use super::*;
use nucleus_core::RevisionId;
use nucleus_projects::{ProjectId, RepoMembershipId};
use nucleus_scm_forge::ScmRepositoryRefId;
use crate::{
    validate_projection_envelope, EngineRuntimeReceiptRecordId,
    ManagementProjectionApplyCommand, ManagementProjectionApplyCommandId,
    ManagementProjectionApplyRecordTarget,
    ManagementProjectionConflictClass, ManagementProjectionConflictReport,
    ManagementProjectionEnvelope, ManagementProjectionExcludedStateMarker,
    ManagementProjectionFileRef, ManagementProjectionRecordId, ManagementProjectionRecordKind,
    ManagementProjectionRoot,
    ManagementProjectionSchemaConflictKind, ManagementProjectionSchemaVersion,
    ManagementProjectionScmConflictKind, ManagementProjectionSemanticConflictKind,
    ManagementProjectionUnsupportedConflictKind, ManagementProjectionValidationStatus,
};

    #[test]
    fn management_projection_sync_plans_separate_export_import_and_capture_prep() {
        let export = ManagementProjectionSyncPlan::export(
            ManagementProjectionSyncPlanId("sync-plan:export".to_owned()),
            vec![ManagementProjectionFileRef::project()],
        );
        let import = ManagementProjectionSyncPlan::import(
            ManagementProjectionSyncPlanId("sync-plan:import".to_owned()),
            vec![ManagementProjectionFileRef::task("task:1")],
        );
        let capture = ManagementProjectionSyncPlan::capture_preparation(
            ManagementProjectionSyncPlanId("sync-plan:capture".to_owned()),
            vec![ManagementProjectionFileRef::task("task:1")],
            vec![EngineRuntimeReceiptRecordId(
                "receipt:projection:1".to_owned(),
            )],
        );

        assert_eq!(export.kind, ManagementProjectionSyncPlanKind::Export);
        assert_eq!(import.kind, ManagementProjectionSyncPlanKind::Import);
        assert_eq!(
            capture.kind,
            ManagementProjectionSyncPlanKind::CapturePreparation
        );
        assert!(export.cites_projection_files());
        assert!(!export.implies_provider_mutation());
        assert!(!import.implies_provider_mutation());
        assert!(!capture.implies_provider_mutation());
    }

    #[test]
    fn management_projection_import_repair_preserves_invalid_and_unsupported_records() {
        let invalid = ManagementProjectionEnvelope {
            schema_version: ManagementProjectionSchemaVersion::current(),
            record_id: ManagementProjectionRecordId(String::new()),
            record_kind: ManagementProjectionRecordKind::Task,
            file_ref: ManagementProjectionFileRef("outside/task.toml".to_owned()),
        };
        let unsupported = ManagementProjectionEnvelope {
            schema_version: ManagementProjectionSchemaVersion("future".to_owned()),
            record_id: ManagementProjectionRecordId("task:future".to_owned()),
            record_kind: ManagementProjectionRecordKind::Task,
            file_ref: ManagementProjectionFileRef::task("task:future"),
        };

        let invalid_report = validate_projection_envelope(
            &invalid,
            &[ManagementProjectionExcludedStateMarker::PerProjectPanelLayout],
        );
        let unsupported_report = validate_projection_envelope(&unsupported, &[]);
        let invalid_proposal = ManagementProjectionImportRepairProposal::from_validation_report(
            ManagementProjectionImportRepairProposalId("repair:invalid".to_owned()),
            &invalid_report,
        )
        .expect("invalid proposal");
        let unsupported_proposal =
            ManagementProjectionImportRepairProposal::from_validation_report(
                ManagementProjectionImportRepairProposalId("repair:unsupported".to_owned()),
                &unsupported_report,
            )
            .expect("unsupported proposal");

        assert_eq!(
            invalid_proposal.kind,
            ManagementProjectionImportRepairKind::SchemaRepair
        );
        assert_eq!(
            unsupported_proposal.kind,
            ManagementProjectionImportRepairKind::UnsupportedPreservation
        );
        assert!(unsupported_proposal.preserves_unsupported_record());
        assert!(!invalid_proposal.can_silently_overwrite_task_meaning());
        assert!(!unsupported_proposal.can_silently_overwrite_task_meaning());
        assert!(invalid_proposal.issue_summaries.iter().any(|summary| {
            summary.contains("management projection files must live under nucleus/")
        }));
    }

    #[test]
    fn management_projection_conflict_routes_keep_mechanical_and_semantic_separate() {
        let schema = conflict_report(ManagementProjectionConflictClass::Schema(
            ManagementProjectionSchemaConflictKind::InvalidRecordShape,
        ));
        let semantic = conflict_report(ManagementProjectionConflictClass::Semantic(
            ManagementProjectionSemanticConflictKind::AcceptanceCriteriaRewrite,
        ));
        let unsupported = conflict_report(ManagementProjectionConflictClass::Unsupported(
            ManagementProjectionUnsupportedConflictKind::UnsupportedSchemaPreserved,
        ));
        let scm = conflict_report(ManagementProjectionConflictClass::Scm(
            ManagementProjectionScmConflictKind::FileChangedDuringImport,
        ));

        let schema_route = ManagementProjectionSyncAssistanceRoute::from_conflict_report(&schema);
        let semantic_route =
            ManagementProjectionSyncAssistanceRoute::from_conflict_report(&semantic);
        let unsupported_route =
            ManagementProjectionSyncAssistanceRoute::from_conflict_report(&unsupported);
        let scm_route = ManagementProjectionSyncAssistanceRoute::from_conflict_report(&scm);

        assert_eq!(
            schema_route.kind,
            ManagementProjectionSyncAssistanceKind::MechanicalConflictRepair
        );
        assert_eq!(
            semantic_route.kind,
            ManagementProjectionSyncAssistanceKind::SemanticConflictEscalation
        );
        assert_eq!(
            unsupported_route.kind,
            ManagementProjectionSyncAssistanceKind::UnsupportedRecordPreservation
        );
        assert_eq!(
            scm_route.kind,
            ManagementProjectionSyncAssistanceKind::ScmRetryOrRestage
        );
        assert!(!schema_route.hides_semantic_conflict());
        assert!(semantic_route.requires_human_approval());
        assert!(unsupported_route.requires_human_approval());
        assert!(!schema_route.can_mutate_shared_projection());
        assert!(!semantic_route.can_mutate_shared_projection());
        assert_eq!(semantic_route.file_ref, ManagementProjectionFileRef::task("task:1"));
    }

    #[test]
    fn management_projection_capture_prep_is_not_provider_execution() {
        let mut plan = ManagementProjectionSyncPlan::capture_preparation(
            ManagementProjectionSyncPlanId("sync-plan:capture".to_owned()),
            vec![
                ManagementProjectionFileRef::project(),
                ManagementProjectionFileRef::task("task:1"),
            ],
            vec![EngineRuntimeReceiptRecordId(
                "receipt:projection:1".to_owned(),
            )],
        );
        plan.status = ManagementProjectionSyncPlanStatus::Ready;
        plan.summary = Some("prepare projection files for later SCM capture".to_owned());

        let prep = ManagementProjectionCapturePrepRecord::from_sync_plan(
            ManagementProjectionCapturePrepId("capture-prep:1".to_owned()),
            &plan,
            vec!["sync-assist:1".to_owned()],
        );

        assert!(!prep.is_execution());
        assert_eq!(prep.status, ManagementProjectionCapturePrepStatus::Draft);
        assert!(prep.cites_projection_files_and_receipts());
        assert_eq!(prep.plan_id, plan.plan_id);
        assert_eq!(prep.assistance_refs, vec!["sync-assist:1".to_owned()]);
    }

    #[test]
    fn management_capture_command_admits_provider_neutral_capture_prep() {
        let command = capture_command(vec![
            ManagementProjectionCapturePolicyGate::ProjectionApplied,
            ManagementProjectionCapturePolicyGate::ExpectedRevisionSatisfied,
            ManagementProjectionCapturePolicyGate::EvidenceSanitized,
        ]);
        let admission = command.admit();
        let prep = ManagementProjectionCapturePrepRecord::from_admitted_command(
            ManagementProjectionCapturePrepId("capture-prep:accepted".to_owned()),
            &command,
            &admission,
        );

        assert!(admission.is_accepted());
        assert!(!admission.provider_mutation_allowed);
        assert!(!command.mutates_provider());
        assert!(!command.is_share_or_publish());
        assert_eq!(
            prep.share_readiness(),
            ManagementProjectionCaptureShareReadiness::ReadyForReviewBoundary
        );
        assert_eq!(
            prep.file_refs,
            vec![
                ManagementProjectionFileRef::project(),
                ManagementProjectionFileRef::task("task:1")
            ]
        );
    }

    #[test]
    fn management_capture_command_blocks_missing_or_unsafe_evidence() {
        let mut missing_evidence = capture_command(Vec::new());
        missing_evidence.evidence.apply_receipt_ids.clear();
        let missing_admission = missing_evidence.admit();

        assert!(!missing_admission.is_accepted());
        assert!(matches!(
            missing_admission.status,
            ManagementProjectionCaptureAdmissionStatus::Blocked(_)
        ));

        let mut unsafe_file = capture_command(Vec::new());
        unsafe_file.requested_file_refs = vec![ManagementProjectionFileRef(
            ".nucleus/tasks/task:1.toml".to_owned(),
        )];
        let unsafe_admission = unsafe_file.admit();

        assert!(!unsafe_admission.is_accepted());
        assert!(matches!(
            unsafe_admission.status,
            ManagementProjectionCaptureAdmissionStatus::Blocked(_)
        ));
    }

    #[test]
    fn management_capture_command_blocks_policy_gates() {
        let command = capture_command(vec![ManagementProjectionCapturePolicyGate::Blocked(
            "conflict review is incomplete".to_owned(),
        )]);
        let admission = command.admit();
        let prep = ManagementProjectionCapturePrepRecord::from_admitted_command(
            ManagementProjectionCapturePrepId("capture-prep:blocked".to_owned()),
            &command,
            &admission,
        );

        assert!(!admission.is_accepted());
        assert_eq!(
            prep.share_readiness(),
            ManagementProjectionCaptureShareReadiness::Blocked(
                "capture command has blocking policy gates".to_owned()
            )
        );
    }

    #[test]
    fn management_capture_records_allow_git_and_convergence_mappings_without_core_terms() {
        let git = capture_command(vec![ManagementProjectionCapturePolicyGate::ProjectionApplied]);
        let convergence = ManagementProjectionCaptureCommand {
            repository_id: Some(ScmRepositoryRefId("scm-repo:convergence".to_owned())),
            reason: ManagementProjectionCaptureReason::StewardRecommended,
            ..capture_command(vec![ManagementProjectionCapturePolicyGate::ProjectionApplied])
        };
        let debug = format!("{git:?}{convergence:?}");

        for forbidden in [
            "commit",
            "push",
            "pull request",
            "branch",
            "snap",
            "publication",
            "provider credential",
            "raw_stdout",
            "raw_stderr",
        ] {
            assert!(
                !debug.to_lowercase().contains(forbidden),
                "capture records leaked provider term {forbidden}"
            );
        }
        assert!(git.admit().is_accepted());
        assert!(convergence.admit().is_accepted());
    }

    fn conflict_report(
        class: ManagementProjectionConflictClass,
    ) -> ManagementProjectionConflictReport {
        ManagementProjectionConflictReport {
            conflict_id: "conflict:projection:1".to_owned(),
            file_ref: ManagementProjectionFileRef::task("task:1"),
            local_record_ref: Some(ManagementProjectionRecordId("task:1".to_owned())),
            incoming_record_ref: Some(ManagementProjectionRecordId("task:1".to_owned())),
            class,
            summary: "projection conflict evidence".to_owned(),
        }
    }

    fn capture_command(
        policy_gates: Vec<ManagementProjectionCapturePolicyGate>,
    ) -> ManagementProjectionCaptureCommand {
        ManagementProjectionCaptureCommand {
            command_id: ManagementProjectionCaptureCommandId("capture-command:1".to_owned()),
            actor_ref: "actor:steward".to_owned(),
            target_project_id: ProjectId("project:nucleus".to_owned()),
            repo_membership_id: Some(RepoMembershipId("repo:nucleus".to_owned())),
            repository_id: Some(ScmRepositoryRefId("scm-repo:nucleus".to_owned())),
            projection_root: ManagementProjectionRoot::default(),
            requested_file_refs: vec![
                ManagementProjectionFileRef::project(),
                ManagementProjectionFileRef::task("task:1"),
            ],
            reason: ManagementProjectionCaptureReason::AppliedManagementProjection,
            scope: ManagementProjectionCaptureScope::ManagementProjection,
            policy_gates,
            evidence: ManagementProjectionCaptureEvidence {
                projection_file_refs: vec![
                    ManagementProjectionFileRef::project(),
                    ManagementProjectionFileRef::task("task:1"),
                ],
                apply_receipt_ids: vec![EngineRuntimeReceiptRecordId(
                    "receipt:management-projection-apply:task:1:accepted".to_owned(),
                )],
                review_summary_refs: vec!["sync-review:1".to_owned()],
                validation_report_refs: vec!["validation:1".to_owned()],
                blocked_reasons: Vec::new(),
            },
        }
    }

    #[test]
    fn management_projection_import_repair_ignores_valid_reports() {
        let envelope = ManagementProjectionEnvelope {
            schema_version: ManagementProjectionSchemaVersion::current(),
            record_id: ManagementProjectionRecordId("task:valid".to_owned()),
            record_kind: ManagementProjectionRecordKind::Task,
            file_ref: ManagementProjectionFileRef::task("task:valid"),
        };
        let report = validate_projection_envelope(&envelope, &[]);

        assert_eq!(report.status, ManagementProjectionValidationStatus::Valid);
        assert!(
            ManagementProjectionImportRepairProposal::from_validation_report(
                ManagementProjectionImportRepairProposalId("repair:none".to_owned()),
                &report,
            )
            .is_none()
        );
    }

    #[test]
    fn management_projection_apply_command_is_explicit_and_non_scm_mutating() {
        let command = ManagementProjectionApplyCommand {
            command_id: ManagementProjectionApplyCommandId("apply:1".to_owned()),
            actor_ref: "actor:steward".to_owned(),
            target_project_id: "project:nucleus".to_owned(),
            targets: vec![ManagementProjectionApplyRecordTarget {
                record_id: ManagementProjectionRecordId("task:1".to_owned()),
                expected_current_revision: Some(RevisionId("rev:task:1".to_owned())),
            }],
            validation_report_refs: vec!["validation:1".to_owned()],
            conflict_resolution_refs: Vec::new(),
        };

        assert!(command.requires_explicit_targets());
        assert!(!command.mutates_scm());
        assert_eq!(
            command.targets[0].record_id,
            ManagementProjectionRecordId("task:1".to_owned())
        );
    }

    #[test]
    fn management_projection_sync_records_do_not_encode_provider_mutation_terms() {
        let plan = ManagementProjectionSyncPlan::capture_preparation(
            ManagementProjectionSyncPlanId("sync-plan:capture".to_owned()),
            vec![ManagementProjectionFileRef::task("task:1")],
            vec![EngineRuntimeReceiptRecordId(
                "receipt:projection:1".to_owned(),
            )],
        );
        let prep = ManagementProjectionCapturePrepRecord::from_sync_plan(
            ManagementProjectionCapturePrepId("capture-prep:1".to_owned()),
            &plan,
            vec!["sync-assist:1".to_owned()],
        );
        let debug = format!("{plan:?}{prep:?}");

        for forbidden in [
            "commit",
            "push",
            "publication_requested",
            "published",
            "provider credential",
            "raw_stdout",
            "raw_stderr",
        ] {
            assert!(
                !debug.to_lowercase().contains(forbidden),
                "sync records leaked {forbidden}"
            );
        }
    }
