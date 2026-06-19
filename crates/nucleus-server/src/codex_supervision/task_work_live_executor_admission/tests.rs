use super::*;
use crate::codex_supervision::{
    codex_task_backed_live_execution_policy, CodexAppServerTaskBackedLiveExecutionPathwayEvidence,
    CodexAppServerTaskBackedLiveExecutionPolicyInput,
    CodexAppServerTaskBackedLiveExecutionToolPolicy,
    CodexAppServerTaskBackedLiveExecutionToolProjectionMode,
};
use crate::host_authority::EngineHostId;

fn accepted_policy() -> CodexAppServerTaskBackedLiveExecutionPolicyRecord {
    codex_task_backed_live_execution_policy(CodexAppServerTaskBackedLiveExecutionPolicyInput {
        work_item_id: EngineTaskWorkItemId("work:1".to_owned()),
        task_id: TaskId("task:1".to_owned()),
        project_id: ProjectId("project:1".to_owned()),
        provider_instance_id: "codex:local-default".to_owned(),
        runtime_session_ref: Some("runtime-session:1".to_owned()),
        adapter_id: "codex-app-server".to_owned(),
        execution_host_id: EngineHostId("host:local".to_owned()),
        operator_evidence_ref: Some("operator-evidence:1".to_owned()),
        pathway_evidence: CodexAppServerTaskBackedLiveExecutionPathwayEvidence::RoadmapReadyCard {
            roadmap_ref: "roadmap:069".to_owned(),
            card_ref: "card:310".to_owned(),
            evidence_ref: "pathway-evidence:310".to_owned(),
        },
        tool_policy: CodexAppServerTaskBackedLiveExecutionToolPolicy {
            projection_mode: CodexAppServerTaskBackedLiveExecutionToolProjectionMode::PortalTool,
            adapter_capability_evidence_ref: Some(
                "adapter-capability-evidence:codex:tools".to_owned(),
            ),
            portal_tool_family: Some("Effigy".to_owned()),
            published_actions: vec!["run_selector_request".to_owned()],
            flat_tool_count: 1,
        },
        callback_response_requested: false,
        cancellation_requested: false,
        resume_requested: false,
        task_completion_requested: false,
        review_acceptance_requested: false,
        scm_mutation_requested: false,
        raw_provider_material_requested: false,
    })
}

fn ready_input() -> CodexAppServerTaskWorkLiveExecutorAdmissionInput {
    CodexAppServerTaskWorkLiveExecutorAdmissionInput {
        policy: accepted_policy(),
        work_item_id: EngineTaskWorkItemId("work:1".to_owned()),
        task_id: TaskId("task:1".to_owned()),
        project_id: ProjectId("project:1".to_owned()),
        provider_instance_id: "codex:local-default".to_owned(),
        runtime_session_ref: "runtime-session:1".to_owned(),
        live_executor_write_attempt_id: ProviderTransportWriteAttemptId(
            "provider-transport-write:1".to_owned(),
        ),
        idempotency_key: ProviderTransportWriteIdempotencyKey(
            "codex-live-executor:work:1".to_owned(),
        ),
        evidence_refs: vec!["admission-evidence:1".to_owned()],
        invoke_executor_requested: false,
        raw_provider_material_requested: false,
        task_mutation_requested: false,
    }
}

#[test]
fn admission_accepts_matching_policy_and_preserves_identity_without_execution() {
    let admission = admit_codex_task_work_live_executor(ready_input());

    assert_eq!(
        admission.status,
        CodexAppServerTaskWorkLiveExecutorAdmissionStatus::AcceptedForExecutorHandoff
    );
    assert_eq!(
        admission.work_item_id,
        EngineTaskWorkItemId("work:1".to_owned())
    );
    assert_eq!(admission.task_id, TaskId("task:1".to_owned()));
    assert_eq!(admission.project_id, ProjectId("project:1".to_owned()));
    assert_eq!(admission.provider_instance_id, "codex:local-default");
    assert_eq!(admission.runtime_session_ref, "runtime-session:1");
    assert_eq!(
        admission.live_executor_write_attempt_id,
        ProviderTransportWriteAttemptId("provider-transport-write:1".to_owned())
    );
    assert_eq!(
        admission.idempotency_key,
        ProviderTransportWriteIdempotencyKey("codex-live-executor:work:1".to_owned())
    );
    assert!(admission
        .evidence_refs
        .contains(&"admission-evidence:1".to_owned()));
    assert!(!admission.executor_invoked);
    assert!(!admission.provider_write_executed);
    assert!(!admission.raw_provider_material_retained);
    assert!(!admission.task_mutation_permitted);
    assert!(!admission.review_acceptance_permitted);
}

#[test]
fn admission_blocks_non_accepted_policy() {
    let mut input = ready_input();
    input.policy =
        codex_task_backed_live_execution_policy(CodexAppServerTaskBackedLiveExecutionPolicyInput {
            pathway_evidence: CodexAppServerTaskBackedLiveExecutionPathwayEvidence::Missing,
            ..accepted_policy_input()
        });

    let admission = admit_codex_task_work_live_executor(input);

    assert_eq!(
        admission.status,
        CodexAppServerTaskWorkLiveExecutorAdmissionStatus::Blocked
    );
    assert!(admission
        .blockers
        .contains(&CodexAppServerTaskWorkLiveExecutorAdmissionBlocker::PolicyNotAccepted));
}

#[test]
fn admission_blocks_missing_required_identity() {
    let mut input = ready_input();
    input.work_item_id = EngineTaskWorkItemId(String::new());
    input.task_id = TaskId(String::new());
    input.project_id = ProjectId(String::new());
    input.provider_instance_id.clear();
    input.runtime_session_ref.clear();
    input.live_executor_write_attempt_id = ProviderTransportWriteAttemptId(String::new());
    input.idempotency_key = ProviderTransportWriteIdempotencyKey(String::new());

    let admission = admit_codex_task_work_live_executor(input);

    assert_eq!(
        admission.status,
        CodexAppServerTaskWorkLiveExecutorAdmissionStatus::Blocked
    );
    assert!(admission
        .blockers
        .contains(&CodexAppServerTaskWorkLiveExecutorAdmissionBlocker::MissingWorkItemId));
    assert!(admission
        .blockers
        .contains(&CodexAppServerTaskWorkLiveExecutorAdmissionBlocker::MissingTaskId));
    assert!(admission
        .blockers
        .contains(&CodexAppServerTaskWorkLiveExecutorAdmissionBlocker::MissingProjectId));
    assert!(admission
        .blockers
        .contains(&CodexAppServerTaskWorkLiveExecutorAdmissionBlocker::MissingProviderInstanceId));
    assert!(admission
        .blockers
        .contains(&CodexAppServerTaskWorkLiveExecutorAdmissionBlocker::MissingRuntimeSessionRef));
    assert!(admission.blockers.contains(
        &CodexAppServerTaskWorkLiveExecutorAdmissionBlocker::MissingLiveExecutorWriteAttemptId
    ));
    assert!(admission
        .blockers
        .contains(&CodexAppServerTaskWorkLiveExecutorAdmissionBlocker::MissingIdempotencyKey));
}

#[test]
fn admission_blocks_policy_identity_mismatch() {
    let mut input = ready_input();
    input.work_item_id = EngineTaskWorkItemId("work:other".to_owned());
    input.task_id = TaskId("task:other".to_owned());
    input.project_id = ProjectId("project:other".to_owned());
    input.provider_instance_id = "codex:other".to_owned();
    input.runtime_session_ref = "runtime-session:other".to_owned();

    let admission = admit_codex_task_work_live_executor(input);

    assert_eq!(
        admission.status,
        CodexAppServerTaskWorkLiveExecutorAdmissionStatus::Blocked
    );
    assert!(admission
        .blockers
        .contains(&CodexAppServerTaskWorkLiveExecutorAdmissionBlocker::WorkItemPolicyMismatch));
    assert!(admission
        .blockers
        .contains(&CodexAppServerTaskWorkLiveExecutorAdmissionBlocker::TaskPolicyMismatch));
    assert!(admission
        .blockers
        .contains(&CodexAppServerTaskWorkLiveExecutorAdmissionBlocker::ProjectPolicyMismatch));
    assert!(admission.blockers.contains(
        &CodexAppServerTaskWorkLiveExecutorAdmissionBlocker::ProviderInstancePolicyMismatch
    ));
    assert!(admission.blockers.contains(
        &CodexAppServerTaskWorkLiveExecutorAdmissionBlocker::RuntimeSessionPolicyMismatch
    ));
}

#[test]
fn admission_blocks_executor_invocation_and_mutation_requests() {
    let mut input = ready_input();
    input.invoke_executor_requested = true;
    input.raw_provider_material_requested = true;
    input.task_mutation_requested = true;

    let admission = admit_codex_task_work_live_executor(input);

    assert_eq!(
        admission.status,
        CodexAppServerTaskWorkLiveExecutorAdmissionStatus::Blocked
    );
    assert_eq!(
        admission.blockers,
        vec![
            CodexAppServerTaskWorkLiveExecutorAdmissionBlocker::ExecutorInvocationRequested,
            CodexAppServerTaskWorkLiveExecutorAdmissionBlocker::RawProviderMaterialRequested,
            CodexAppServerTaskWorkLiveExecutorAdmissionBlocker::TaskMutationRequested,
        ]
    );
    assert!(!admission.executor_invoked);
    assert!(!admission.provider_write_executed);
    assert!(!admission.task_mutation_permitted);
}

fn accepted_policy_input() -> CodexAppServerTaskBackedLiveExecutionPolicyInput {
    CodexAppServerTaskBackedLiveExecutionPolicyInput {
        work_item_id: EngineTaskWorkItemId("work:1".to_owned()),
        task_id: TaskId("task:1".to_owned()),
        project_id: ProjectId("project:1".to_owned()),
        provider_instance_id: "codex:local-default".to_owned(),
        runtime_session_ref: Some("runtime-session:1".to_owned()),
        adapter_id: "codex-app-server".to_owned(),
        execution_host_id: EngineHostId("host:local".to_owned()),
        operator_evidence_ref: Some("operator-evidence:1".to_owned()),
        pathway_evidence: CodexAppServerTaskBackedLiveExecutionPathwayEvidence::RoadmapReadyCard {
            roadmap_ref: "roadmap:069".to_owned(),
            card_ref: "card:310".to_owned(),
            evidence_ref: "pathway-evidence:310".to_owned(),
        },
        tool_policy: CodexAppServerTaskBackedLiveExecutionToolPolicy {
            projection_mode: CodexAppServerTaskBackedLiveExecutionToolProjectionMode::PortalTool,
            adapter_capability_evidence_ref: Some(
                "adapter-capability-evidence:codex:tools".to_owned(),
            ),
            portal_tool_family: Some("Effigy".to_owned()),
            published_actions: vec!["run_selector_request".to_owned()],
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
