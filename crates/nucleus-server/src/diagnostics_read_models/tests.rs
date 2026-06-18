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
