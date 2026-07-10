use crate::control_api::{
    ServerControlError, ServerControlResponse, ServerControlResponseBody,
    ServerControlResponseStatus, ServerQueryResult, ServerStateRecordSet,
};
use crate::control_envelope_dto::*;
use crate::ids::ServerControlRequestId;
use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{LocalStoreRecord, LocalStoreRecordPayload};
use nucleus_planning::{
    encode_goal_storage_record, Goal, GoalStatus, GoalTimestamps, PlanningGoalId,
};
use nucleus_projects::{
    encode_project_storage_record, ImportanceBaseline, ImportanceLevel, Project, ProjectActivity,
    ProjectId, ProjectStatus,
};
use nucleus_tasks::{
    encode_task_storage_record, AcceptanceCriterion, AgentReadiness, AssignmentState, NeglectLevel,
    NeglectSignal, Task, TaskActionType, TaskActivityState, TaskId, TaskImportance, TaskTimestamps,
};

#[test]
fn response_envelope_dto_serializes_status_error_and_state_records() {
    let project = Project {
        id: ProjectId("project:dto".to_owned()),
        display_name: "DTO Project".to_owned(),
        status: ProjectStatus::Active,
        importance_baseline: ImportanceBaseline {
            level: ImportanceLevel::High,
            notes: None,
        },
        repos: Vec::new(),
        task_ids: Vec::new(),
        workspace_layout_refs: Vec::new(),
        activity: ProjectActivity {
            created_at: None,
            last_focused_at: None,
            last_agent_activity_at: None,
            last_task_activity_at: None,
        },
    };
    let response = ServerControlResponse {
        request_id: ServerControlRequestId("request:dto:response".to_owned()),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(ServerQueryResult::StateRecords(
            ServerStateRecordSet {
                domain: ServerStateDomain::Projects,
                records: vec![LocalStoreRecord {
                    id: PersistenceRecordId("project:dto".to_owned()),
                    domain: PersistenceDomain::Projects,
                    kind: PersistenceRecordKind::Project,
                    revision_id: RevisionId("rev:1".to_owned()),
                    payload: LocalStoreRecordPayload {
                        media_type: Some("application/json".to_owned()),
                        bytes: encode_project_storage_record(&project).expect("project json"),
                    },
                }],
            },
        )),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let json = serde_json::to_string(&dto).expect("json");
    let decoded: ControlResponseEnvelopeDto = serde_json::from_str(&json).expect("decoded dto");

    assert_eq!(decoded.status, ControlResponseStatusDto::Complete);
    match decoded.body {
        ControlResponseBodyDto::ProjectRecords { records } => {
            assert_eq!(records.len(), 1);
            assert_eq!(records[0].repo_count, 0);
            assert_eq!(records[0].primary_location, None);
            assert_eq!(records[0].location_status, "not_recorded");
        }
        other => panic!("expected project records, got {other:?}"),
    }
}

#[test]
fn response_envelope_dto_serializes_task_records() {
    let task = Task {
        id: TaskId("task:dto".to_owned()),
        project_id: ProjectId("project:dto".to_owned()),
        title: "DTO Task".to_owned(),
        description: Some("Display task records".to_owned()),
        acceptance_criteria: vec![AcceptanceCriterion {
            text: "Task appears in typed response".to_owned(),
            required: true,
        }],
        importance: TaskImportance::Critical,
        neglect: NeglectSignal {
            level: NeglectLevel::Fresh,
            last_addressed_at: None,
            note: None,
        },
        action_type: TaskActionType::Check,
        assignment: AssignmentState::Human("tom".to_owned()),
        activity: TaskActivityState::Active,
        agent_readiness: AgentReadiness {
            ready_for_agent: false,
            required_context_refs: vec!["docs/contracts/005-task-contract.md".to_owned()],
            allowed_actions: vec![TaskActionType::Check],
            stop_conditions: vec!["Stop on contract ambiguity".to_owned()],
            validation_commands: vec!["effigy qa".to_owned()],
        },
        assignment_plan: None,
        assignment_snapshot: None,
        history: Vec::new(),
        model_preferences: None,
        timestamps: TaskTimestamps {
            created_at: None,
            updated_at: None,
            started_at: None,
            completed_at: None,
        },
    };
    let response = ServerControlResponse {
        request_id: ServerControlRequestId("request:dto:task-response".to_owned()),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(ServerQueryResult::StateRecords(
            ServerStateRecordSet {
                domain: ServerStateDomain::Tasks,
                records: vec![LocalStoreRecord {
                    id: PersistenceRecordId("task:dto".to_owned()),
                    domain: PersistenceDomain::Tasks,
                    kind: PersistenceRecordKind::Task,
                    revision_id: RevisionId("rev:task:1".to_owned()),
                    payload: LocalStoreRecordPayload {
                        media_type: Some("application/json".to_owned()),
                        bytes: encode_task_storage_record(&task).expect("task json"),
                    },
                }],
            },
        )),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let json = serde_json::to_string(&dto).expect("json");
    let decoded: ControlResponseEnvelopeDto = serde_json::from_str(&json).expect("decoded dto");

    assert!(matches!(
        decoded.body,
        ControlResponseBodyDto::TaskRecords { records }
            if records.len() == 1
                && records[0].task_id == "task:dto"
                && records[0].project_id == "project:dto"
                && records[0].title == "DTO Task"
                && records[0].importance == "critical"
                && records[0].action_type == "check"
                && records[0].activity == "active"
                && records[0].acceptance_criteria.len() == 1
                && records[0].required_context_refs == ["docs/contracts/005-task-contract.md"]
                && records[0].allowed_actions == ["check"]
                && records[0].stop_conditions == ["Stop on contract ambiguity"]
                && records[0].validation_commands == ["effigy qa"]
                && records[0].blocked_reason.is_none()
    ));
}

#[test]
fn response_envelope_dto_serializes_goal_records() {
    let goal = Goal {
        id: PlanningGoalId("goal:dto".to_owned()),
        project_id: ProjectId("project:dto".to_owned()),
        title: "DTO Goal".to_owned(),
        desired_outcome: "Goal records reach the desktop.".to_owned(),
        scope: "Typed Goal state query".to_owned(),
        status: GoalStatus::Ready,
        owner_refs: vec!["operator:tom".to_owned()],
        ordered_task_refs: vec![TaskId("task:dto".to_owned())],
        planning_artifact_refs: Vec::new(),
        provenance_refs: vec!["conversation:dto".to_owned()],
        stop_conditions: vec!["Stop on invalid membership".to_owned()],
        evidence_refs: Vec::new(),
        current_next_task_ref: Some(TaskId("task:dto".to_owned())),
        next_action: Some("Select the first task".to_owned()),
        timestamps: GoalTimestamps {
            created_at: None,
            updated_at: None,
            achieved_at: None,
        },
    };
    let response = ServerControlResponse {
        request_id: ServerControlRequestId("request:dto:goal-response".to_owned()),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(ServerQueryResult::StateRecords(
            ServerStateRecordSet {
                domain: ServerStateDomain::Goals,
                records: vec![LocalStoreRecord {
                    id: PersistenceRecordId(goal.id.0.clone()),
                    domain: PersistenceDomain::Planning,
                    kind: PersistenceRecordKind::Goal,
                    revision_id: RevisionId("rev:goal:1".to_owned()),
                    payload: LocalStoreRecordPayload {
                        media_type: Some("application/json".to_owned()),
                        bytes: encode_goal_storage_record(&goal).expect("goal json"),
                    },
                }],
            },
        )),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("goal response dto");

    assert!(matches!(
        dto.body,
        ControlResponseBodyDto::GoalRecords { records }
            if records.len() == 1
                && records[0].goal_id == "goal:dto"
                && records[0].ordered_task_refs == ["task:dto"]
                && records[0].revision_id == "rev:goal:1"
    ));
}

#[test]
fn response_error_shape_is_explicit() {
    let response = ServerControlResponse {
        request_id: ServerControlRequestId("request:dto:error".to_owned()),
        status: ServerControlResponseStatus::Rejected,
        body: ServerControlResponseBody::Error(ServerControlError::Deferred {
            reason: "not wired".to_owned(),
        }),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");

    assert_eq!(dto.status, ControlResponseStatusDto::Rejected);
    assert_eq!(
        dto.body,
        ControlResponseBodyDto::Error {
            kind: "deferred".to_owned(),
            reason: "not wired".to_owned(),
        }
    );
}
