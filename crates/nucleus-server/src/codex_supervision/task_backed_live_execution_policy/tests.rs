use super::*;

fn ready_input() -> CodexAppServerTaskBackedLiveExecutionPolicyInput {
    CodexAppServerTaskBackedLiveExecutionPolicyInput {
        work_item_id: EngineTaskWorkItemId("work:1".to_owned()),
        task_id: TaskId("task:1".to_owned()),
        project_id: ProjectId("project:1".to_owned()),
        provider_instance_id: "codex:local-default".to_owned(),
        runtime_session_ref: Some("runtime-session:codex:1".to_owned()),
        adapter_id: "codex-app-server".to_owned(),
        execution_host_id: EngineHostId("host:local".to_owned()),
        operator_evidence_ref: Some("operator-evidence:live-executor:1".to_owned()),
        pathway_evidence: CodexAppServerTaskBackedLiveExecutionPathwayEvidence::RoadmapReadyCard {
            roadmap_ref: "docs/roadmaps/g02/069-codex-task-backed-live-execution-gate.md"
                .to_owned(),
            card_ref: "docs/roadmaps/g02/batch-cards/309-task-backed-live-execution-policy-gate.md"
                .to_owned(),
            evidence_ref: "pathway-evidence:ready-card:309".to_owned(),
        },
        tool_policy: CodexAppServerTaskBackedLiveExecutionToolPolicy {
            projection_mode: CodexAppServerTaskBackedLiveExecutionToolProjectionMode::PortalTool,
            adapter_capability_evidence_ref: Some(
                "adapter-capability-evidence:codex-tools:1".to_owned(),
            ),
            portal_tool_family: Some("Effigy".to_owned()),
            published_actions: vec![
                "list_selectors".to_owned(),
                "doctor_summary".to_owned(),
                "test_plan_summary".to_owned(),
                "run_selector_request".to_owned(),
            ],
            flat_tool_count: 1,
        },
        callback_response_requested: false,
        cancellation_requested: false,
        resume_requested: false,
        task_completion_requested: false,
        review_acceptance_requested: false,
        scm_mutation_requested: false,
        raw_provider_material_requested: false,
    }
}

#[test]
fn task_backed_live_execution_policy_accepts_complete_pathway_and_portal_tool() {
    let record = codex_task_backed_live_execution_policy(ready_input());

    assert_eq!(
        record.status,
        CodexAppServerTaskBackedLiveExecutionPolicyStatus::AcceptedForLiveExecutorAdmission
    );
    assert!(record.blockers.is_empty());
    assert!(record
        .evidence_refs
        .contains(&"pathway-evidence:ready-card:309".to_owned()));
    assert!(record.evidence_refs.contains(&"tool:Effigy".to_owned()));
    assert!(!record.provider_write_executed);
    assert!(!record.callback_response_permitted);
    assert!(!record.cancellation_permitted);
    assert!(!record.resume_permitted);
    assert!(!record.task_completion_permitted);
    assert!(!record.review_acceptance_permitted);
    assert!(!record.scm_mutation_permitted);
    assert!(!record.raw_provider_material_retained);
}

#[test]
fn task_backed_live_execution_policy_blocks_missing_pathway_evidence() {
    let mut input = ready_input();
    input.pathway_evidence = CodexAppServerTaskBackedLiveExecutionPathwayEvidence::Missing;

    let record = codex_task_backed_live_execution_policy(input);

    assert_eq!(
        record.status,
        CodexAppServerTaskBackedLiveExecutionPolicyStatus::Blocked
    );
    assert_eq!(
        record.blockers,
        vec![CodexAppServerTaskBackedLiveExecutionPolicyBlocker::MissingPathwayEvidence]
    );
}

#[test]
fn task_backed_live_execution_policy_blocks_missing_required_identity() {
    let mut input = ready_input();
    input.work_item_id = EngineTaskWorkItemId(String::new());
    input.task_id = TaskId(String::new());
    input.project_id = ProjectId(String::new());
    input.provider_instance_id.clear();
    input.runtime_session_ref = None;
    input.adapter_id.clear();
    input.execution_host_id = EngineHostId(String::new());
    input.operator_evidence_ref = None;

    let record = codex_task_backed_live_execution_policy(input);

    assert_eq!(
        record.status,
        CodexAppServerTaskBackedLiveExecutionPolicyStatus::Blocked
    );
    assert!(record
        .blockers
        .contains(&CodexAppServerTaskBackedLiveExecutionPolicyBlocker::MissingWorkItemId));
    assert!(record
        .blockers
        .contains(&CodexAppServerTaskBackedLiveExecutionPolicyBlocker::MissingTaskId));
    assert!(record
        .blockers
        .contains(&CodexAppServerTaskBackedLiveExecutionPolicyBlocker::MissingProjectId));
    assert!(record
        .blockers
        .contains(&CodexAppServerTaskBackedLiveExecutionPolicyBlocker::MissingProviderInstanceId));
    assert!(record
        .blockers
        .contains(&CodexAppServerTaskBackedLiveExecutionPolicyBlocker::MissingRuntimeSessionRef));
    assert!(record
        .blockers
        .contains(&CodexAppServerTaskBackedLiveExecutionPolicyBlocker::MissingAdapterId));
    assert!(record
        .blockers
        .contains(&CodexAppServerTaskBackedLiveExecutionPolicyBlocker::MissingExecutionHostId));
    assert!(record
        .blockers
        .contains(&CodexAppServerTaskBackedLiveExecutionPolicyBlocker::MissingOperatorEvidence));
}

#[test]
fn task_backed_live_execution_policy_blocks_flat_tool_overload() {
    let mut input = ready_input();
    input.tool_policy = CodexAppServerTaskBackedLiveExecutionToolPolicy {
        projection_mode:
            CodexAppServerTaskBackedLiveExecutionToolProjectionMode::NativeToolRegistration,
        adapter_capability_evidence_ref: Some("adapter-capability-evidence:tools:1".to_owned()),
        portal_tool_family: None,
        published_actions: vec![
            "effigy_list".to_owned(),
            "effigy_doctor".to_owned(),
            "effigy_test_plan".to_owned(),
            "effigy_run".to_owned(),
        ],
        flat_tool_count: 4,
    };

    let record = codex_task_backed_live_execution_policy(input);

    assert_eq!(
        record.status,
        CodexAppServerTaskBackedLiveExecutionPolicyStatus::Blocked
    );
    assert_eq!(
        record.blockers,
        vec![
            CodexAppServerTaskBackedLiveExecutionPolicyBlocker::FlatToolMenuRequested {
                flat_tool_count: 4
            }
        ]
    );
}

#[test]
fn task_backed_live_execution_policy_blocks_invalid_portal_tool_policy() {
    let mut input = ready_input();
    input.tool_policy.adapter_capability_evidence_ref = None;
    input.tool_policy.portal_tool_family = Some(String::new());
    input.tool_policy.published_actions = vec![String::new()];

    let record = codex_task_backed_live_execution_policy(input);

    assert_eq!(
        record.status,
        CodexAppServerTaskBackedLiveExecutionPolicyStatus::Blocked
    );
    assert!(record.blockers.contains(
        &CodexAppServerTaskBackedLiveExecutionPolicyBlocker::MissingAdapterCapabilityEvidence
    ));
    assert!(record
        .blockers
        .contains(&CodexAppServerTaskBackedLiveExecutionPolicyBlocker::MissingPortalToolFamily));
    assert!(record
        .blockers
        .contains(&CodexAppServerTaskBackedLiveExecutionPolicyBlocker::MissingPublishedToolAction));
}

#[test]
fn task_backed_live_execution_policy_blocks_forbidden_authority_requests() {
    let mut input = ready_input();
    input.callback_response_requested = true;
    input.cancellation_requested = true;
    input.resume_requested = true;
    input.task_completion_requested = true;
    input.review_acceptance_requested = true;
    input.scm_mutation_requested = true;
    input.raw_provider_material_requested = true;

    let record = codex_task_backed_live_execution_policy(input);

    assert_eq!(
        record.status,
        CodexAppServerTaskBackedLiveExecutionPolicyStatus::Blocked
    );
    assert_eq!(
        record.blockers,
        vec![
            CodexAppServerTaskBackedLiveExecutionPolicyBlocker::CallbackResponseRequested,
            CodexAppServerTaskBackedLiveExecutionPolicyBlocker::CancellationRequested,
            CodexAppServerTaskBackedLiveExecutionPolicyBlocker::ResumeRequested,
            CodexAppServerTaskBackedLiveExecutionPolicyBlocker::TaskCompletionRequested,
            CodexAppServerTaskBackedLiveExecutionPolicyBlocker::ReviewAcceptanceRequested,
            CodexAppServerTaskBackedLiveExecutionPolicyBlocker::ScmMutationRequested,
            CodexAppServerTaskBackedLiveExecutionPolicyBlocker::RawProviderMaterialRequested,
        ]
    );
    assert!(!record.provider_write_executed);
    assert!(!record.task_completion_permitted);
    assert!(!record.review_acceptance_permitted);
    assert!(!record.raw_provider_material_retained);
}
