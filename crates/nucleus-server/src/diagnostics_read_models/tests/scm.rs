use super::*;

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
    let admission = nucleus_scm_forge::ScmSessionCommandAdmission::from_supported_capabilities(
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
