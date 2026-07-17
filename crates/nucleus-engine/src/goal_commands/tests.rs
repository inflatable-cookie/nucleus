use std::cell::RefCell;
use std::collections::HashMap;

use nucleus_core::{PersistenceRecordId, RevisionId};
use nucleus_planning::GoalStatus;
use nucleus_projects::ProjectId;

use super::model::{
    EngineGoalCommand, EngineGoalCommandError, EngineGoalCreateCommand, EngineGoalRepository,
};
use super::service::EngineGoalCommandService;
use crate::task_commands::{EngineRevisionExpectation, EngineTaskRecord};

#[derive(Default)]
struct MemoryGoalRepository {
    projects: Vec<String>,
    planning: RefCell<HashMap<String, EngineTaskRecord>>,
}

impl EngineGoalRepository for &MemoryGoalRepository {
    type Error = String;

    fn project_exists(&self, project_id: &ProjectId) -> Result<bool, Self::Error> {
        Ok(self.projects.contains(&project_id.0))
    }

    fn get_planning_record(
        &self,
        record_id: &PersistenceRecordId,
    ) -> Result<Option<EngineTaskRecord>, Self::Error> {
        Ok(self.planning.borrow().get(&record_id.0).cloned())
    }

    fn put_planning_record(
        &self,
        record: EngineTaskRecord,
        _revision: EngineRevisionExpectation,
    ) -> Result<(), Self::Error> {
        self.planning
            .borrow_mut()
            .insert(record.id.0.clone(), record);
        Ok(())
    }

    fn get_task_record(
        &self,
        _record_id: &PersistenceRecordId,
    ) -> Result<Option<EngineTaskRecord>, Self::Error> {
        Ok(None)
    }
}

fn create_command(status: GoalStatus) -> EngineGoalCreateCommand {
    EngineGoalCreateCommand {
        project_id: ProjectId("project:nucleus".to_owned()),
        title: "Goal title".to_owned(),
        desired_outcome: "Outcome".to_owned(),
        scope: "Project scope".to_owned(),
        status,
        owner_refs: vec!["operator:tom".to_owned()],
        ordered_task_refs: Vec::new(),
        planning_artifact_refs: Vec::new(),
        provenance_refs: Vec::new(),
        stop_conditions: Vec::new(),
        evidence_refs: Vec::new(),
        current_next_task_ref: None,
        next_action: None,
    }
}

#[test]
fn create_rejects_non_authorable_statuses() {
    let repository = MemoryGoalRepository {
        projects: vec!["project:nucleus".to_owned()],
        ..Default::default()
    };
    let service = EngineGoalCommandService::new(&repository);

    let result = service.execute(
        "command:goal:1",
        EngineGoalCommand::Create(create_command(GoalStatus::Achieved)),
    );

    assert!(matches!(
        result,
        Err(EngineGoalCommandError::InvalidRequest { .. })
    ));
}

#[test]
fn create_requires_existing_project_and_persists_goal_record() {
    let repository = MemoryGoalRepository {
        projects: vec!["project:nucleus".to_owned()],
        ..Default::default()
    };
    let service = EngineGoalCommandService::new(&repository);

    let missing = service.execute(
        "command:goal:2",
        EngineGoalCommand::Create(EngineGoalCreateCommand {
            project_id: ProjectId("project:absent".to_owned()),
            ..create_command(GoalStatus::Proposed)
        }),
    );
    assert!(matches!(missing, Err(EngineGoalCommandError::NotFound { .. })));

    service
        .execute(
            "command:goal:3",
            EngineGoalCommand::Create(create_command(GoalStatus::Proposed)),
        )
        .expect("create goal");

    let stored = repository.planning.borrow();
    let record = stored.get("goal:command:goal:3").expect("goal persisted");
    assert_eq!(
        record.revision_id,
        RevisionId("rev:goal-create:command:goal:3".to_owned())
    );
}
