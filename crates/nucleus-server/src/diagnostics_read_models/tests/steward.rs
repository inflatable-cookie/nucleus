use super::*;

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
fn steward_sync_diagnostics_expose_decisions_without_action_authority() {
    let assistance = NativeStewardSyncAssistance {
        id: NativeStewardSyncAssistanceId("sync-assist:1".to_owned()),
        proposal_id: None,
        kind: NativeStewardSyncAssistanceKind::ManagementCapturePreparation,
        review: NativeStewardProposalReview::Draft,
        links: NativeStewardSyncAssistanceLinks {
            projection_conflict_report_refs: Vec::new(),
            scm_work_session_refs: vec!["scm-session:1".to_owned()],
            change_request_prep_refs: vec!["change-request:1".to_owned()],
            management_projection_refs: vec!["nucleus/tasks/task:1.toml".to_owned()],
        },
        capture_plan: None,
        evidence_refs: vec![NativeStewardEvidenceRef {
            source: NativeStewardEvidenceSource::Scm,
            ref_id: "evidence:scm:status".to_owned(),
        }],
        tool_action_id: None,
        receipt_refs: Vec::new(),
        summary: Some("review management capture evidence".to_owned()),
    };
    let decision = NativeStewardSyncDecisionRecord::recommendation(
        NativeStewardSyncDecisionId("sync-decision:1".to_owned()),
        &assistance,
        NativeStewardSyncNextAction::ReviewCaptureEvidence,
    );
    let diagnostics = steward_sync_diagnostics(&[decision]);
    let json = serde_json::to_string(&diagnostics).expect("serialize steward sync diagnostics");

    assert!(!diagnostics.client_can_mutate);
    assert!(!diagnostics.client_can_mutate_provider);
    assert_eq!(diagnostics.source_status, "records");
    assert!(diagnostics.decisions[0].advisory_only);
    assert!(!diagnostics.decisions[0].provider_mutation_allowed);
    assert_eq!(
        diagnostics.decisions[0].requested_next_action,
        "ReviewCaptureEvidence"
    );
    for forbidden in ["raw_stdout", "raw_stderr", "secret", "push"] {
        assert!(!json.contains(forbidden), "steward sync leaked {forbidden}");
    }
}
