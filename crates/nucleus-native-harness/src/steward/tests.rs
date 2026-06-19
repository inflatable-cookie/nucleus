use super::*;
use crate::personas::NativePersonaId;
use crate::tools::{NativeRuntimeReceiptRef, NativeToolActionId};

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

    #[test]
    fn steward_sync_decisions_are_advisory_and_evidence_linked() {
        let assistance =
            sync_assistance(NativeStewardSyncAssistanceKind::ManagementCapturePreparation);
        let decision = NativeStewardSyncDecisionRecord::recommendation(
            NativeStewardSyncDecisionId("sync-decision:1".to_owned()),
            &assistance,
            NativeStewardSyncNextAction::ReviewCaptureEvidence,
        );

        assert!(decision.is_advisory_only());
        assert!(!decision.provider_mutation_allowed);
        assert_eq!(decision.assistance_id, Some(assistance.id));
        assert_eq!(decision.evidence_refs.len(), 3);
        assert_eq!(
            decision.requested_next_action,
            NativeStewardSyncNextAction::ReviewCaptureEvidence
        );
    }

    #[test]
    fn steward_sync_decisions_block_instead_of_bypassing_sync_gates() {
        let assistance =
            sync_assistance(NativeStewardSyncAssistanceKind::ChangeRequestPreparation);
        let decision = NativeStewardSyncDecisionRecord::blocked(
            NativeStewardSyncDecisionId("sync-decision:blocked".to_owned()),
            &assistance,
            "capture evidence is missing".to_owned(),
        );

        assert!(decision.is_advisory_only());
        assert_eq!(decision.kind, NativeStewardSyncDecisionKind::Blocked);
        assert_eq!(
            decision.requested_next_action,
            NativeStewardSyncNextAction::RequestHumanReview
        );
        assert_eq!(
            decision.blocked_reasons,
            vec!["capture evidence is missing".to_owned()]
        );
        assert!(!decision.provider_mutation_allowed);
    }
