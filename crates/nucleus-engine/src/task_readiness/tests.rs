use super::*;

fn input(id: &str, activity: TaskActivityState) -> EngineTaskReadinessInput {
    EngineTaskReadinessInput {
        task_id: TaskId(id.to_owned()),
        project_id: ProjectId("project:1".to_owned()),
        title: format!("Task {id}"),
        action_type: TaskActionType::Plan,
        activity,
        agent_ready: false,
        required_context_refs: Vec::new(),
        validation_commands: Vec::new(),
        work_item_evidence_refs: Vec::new(),
        timeline_evidence_refs: Vec::new(),
        blocker_refs: Vec::new(),
    }
}

#[test]
fn readiness_projection_classifies_without_mutation_or_provider_execution() {
    let mut agent = input("task:agent", TaskActivityState::Ready);
    agent.agent_ready = true;
    agent.validation_commands = vec!["effigy qa".to_owned()];

    let mut review = input("task:review", TaskActivityState::Ready);
    review
        .work_item_evidence_refs
        .push("work-item:review:1".to_owned());

    let blocked = input(
        "task:blocked",
        TaskActivityState::Blocked("waiting".to_owned()),
    );
    let done = input("task:done", TaskActivityState::Done);

    let projection = EngineTaskReadinessProjection::from_tasks(
        ProjectId("project:1".to_owned()),
        vec![agent, review, blocked, done],
    );

    assert!(!projection.client_can_mutate);
    assert!(!projection.provider_execution_available);
    assert_eq!(projection.candidates.len(), 4);
    assert!(projection
        .candidates
        .iter()
        .any(|candidate| candidate.readiness == EngineTaskReadinessClass::AgentDelegationReady));
    assert!(projection
        .candidates
        .iter()
        .any(|candidate| candidate.readiness == EngineTaskReadinessClass::AwaitingReview));
    assert_eq!(projection.source_counts.task_records, 4);
    assert_eq!(projection.source_counts.validation_command_refs, 1);
    assert_eq!(projection.source_counts.work_item_evidence_refs, 1);
}

#[test]
fn readiness_projection_filters_by_project_and_sorts_by_task_id() {
    let mut other = input("task:other", TaskActivityState::Ready);
    other.project_id = ProjectId("project:other".to_owned());

    let projection = EngineTaskReadinessProjection::from_tasks(
        ProjectId("project:1".to_owned()),
        vec![
            input("task:b", TaskActivityState::Proposed),
            other,
            input("task:a", TaskActivityState::Active),
        ],
    );

    assert_eq!(
        projection
            .candidates
            .iter()
            .map(|candidate| candidate.task_id.0.as_str())
            .collect::<Vec<_>>(),
        vec!["task:a", "task:b"]
    );
}
