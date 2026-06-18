    use super::*;
    use nucleus_engine::{
        EngineCheckpointRecordId, EngineDiffSummaryRecordId, EngineRuntimeReceiptEffectFamily,
        EngineRuntimeReceiptRecord, EngineRuntimeReceiptRecordId, EngineRuntimeReceiptRef,
        EngineRuntimeReceiptStatus,
        EngineScmWorkItemLinkId, EngineScmWorkItemLinkRecord, EngineScmWorkItemLinkState,
        EngineTaskAgentWorkUnitReviewStatus, EngineTaskAgentWorkUnitRuntimeStatus,
        EngineTaskAgentWorkUnitSourceCursor, EngineTaskAgentWorkUnitSourceId,
        EngineTaskAgentWorkUnitSourceRecord, EngineTaskWorkItemId, EngineTaskWorkItemRefs,
        ManagementProjectionCapturePrepId,
        ManagementProjectionCapturePrepRecord, ManagementProjectionCapturePrepStatus,
        ManagementProjectionCaptureScope, ManagementProjectionConflictClass,
        ManagementProjectionConflictReport, ManagementProjectionEnvelope, ManagementProjectionFileDocument,
        ManagementProjectionFileRef, ManagementProjectionImportRepairProposal,
        ManagementProjectionImportRepairProposalId, ManagementProjectionPayload,
        ManagementProjectionRecordId, ManagementProjectionRecordKind,
        ManagementProjectionSchemaConflictKind, ManagementProjectionSchemaVersion,
        ManagementProjectionSemanticConflictKind,
        ManagementProjectionSyncAssistanceRoute, ManagementProjectionSyncPlan,
        ManagementProjectionSyncPlanId, ManagementProjectionValidationReport,
        ManagementProjectionValidationStatus,
    };
    use crate::management_projection_state::{
        ManagementProjectionAppliedRecord, ManagementProjectionApplyBlock,
        ManagementProjectionApplyBlockKind, ManagementProjectionImportApplyReport,
        ManagementProjectionImportStagingReport, ManagementProjectionStagedFile,
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
    use nucleus_projects::ProjectId;
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
            family: EngineRuntimeReceiptEffectFamily::Custom(
                "management_projection_apply".to_owned(),
            ),
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

        let review = management_sync_review_model(
            Some(&staging),
            Some(&apply),
            &[conflict],
            &[],
            &[],
        );
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
    fn task_agent_diagnostics_expose_work_units_without_runtime_authority() {
        let source = EngineTaskAgentWorkUnitSourceRecord {
            source_id: EngineTaskAgentWorkUnitSourceId("source:work:1".to_owned()),
            source_cursor: EngineTaskAgentWorkUnitSourceCursor("cursor:1".to_owned()),
            work_item_id: EngineTaskWorkItemId("work:1".to_owned()),
            project_id: ProjectId("project:1".to_owned()),
            task_id: TaskId("task:1".to_owned()),
            command_id: "command:delegate".to_owned(),
            actor_ref: "actor:operator".to_owned(),
            adapter_id: "adapter:codex".to_owned(),
            provider_instance_id: "codex:local".to_owned(),
            idempotency_key: "click-1".to_owned(),
            task_revision: None,
            runtime: EngineTaskAgentWorkUnitRuntimeStatus::Scheduled,
            review: EngineTaskAgentWorkUnitReviewStatus::NotReady,
            refs: EngineTaskWorkItemRefs {
                session_id: Some(nucleus_agent_protocol::AgentSessionId(
                    "session:codex:1".to_owned(),
                )),
                receipt_ids: vec![EngineRuntimeReceiptRecordId("receipt:1".to_owned())],
                checkpoint_ids: vec![EngineCheckpointRecordId("checkpoint:1".to_owned())],
                diff_summary_ids: vec![EngineDiffSummaryRecordId("diff:1".to_owned())],
                validation_refs: vec!["validation:1".to_owned()],
                artifact_refs: vec!["artifact:summary".to_owned()],
                ..EngineTaskWorkItemRefs::default()
            },
            previous_source_id: None,
            summary: "provider execution deferred".to_owned(),
        };

        let diagnostics = task_agent_diagnostics(&[source]);
        let json = serde_json::to_string(&diagnostics).expect("serialize task-agent diagnostics");

        assert!(!diagnostics.client_can_mutate_work_units);
        assert!(!diagnostics.provider_execution_available);
        assert_eq!(diagnostics.source_status, "records");
        assert_eq!(diagnostics.work_units[0].runtime, "scheduled");
        assert_eq!(diagnostics.work_units[0].review, "not_ready");
        assert_eq!(
            diagnostics.work_units[0].session_id,
            Some("session:codex:1".to_owned())
        );
        assert_eq!(
            diagnostics.work_units[0].receipt_ids,
            vec!["receipt:1".to_owned()]
        );
        assert_eq!(
            diagnostics.work_units[0].checkpoint_ids,
            vec!["checkpoint:1".to_owned()]
        );
        assert_eq!(
            diagnostics.work_units[0].diff_summary_ids,
            vec!["diff:1".to_owned()]
        );
        assert!(!json.contains("raw_stdout"));
        assert!(!json.contains("provider payload"));
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
