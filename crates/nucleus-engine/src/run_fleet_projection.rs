//! Engine-owned fleet read model for orchestration runs.
//!
//! Deterministic rebuild from run records; the desktop fleet panel renders
//! this shape (run id, state, provider, orchestrator designation, recency,
//! closeout presence) per project.

use nucleus_projects::ProjectId;

use crate::run_commands::{EngineRunLifecycleState, EngineRunStorageRecord};

/// Project-scoped fleet projection (contract 033 fleet view).
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineRunFleetProjection {
    pub project_id: ProjectId,
    pub runs: Vec<EngineRunFleetEntry>,
    pub state_counts: Vec<EngineRunStateCount>,
}

/// One fleet row: list runs by project with state, provider, recency.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineRunFleetEntry {
    pub run_id: String,
    pub state: EngineRunLifecycleState,
    pub provider_instance: String,
    pub provider_model: String,
    pub orchestrator_designation: Option<String>,
    pub updated_at: u64,
    pub has_closeout: bool,
}

/// Status board count for one lifecycle state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineRunStateCount {
    pub state: EngineRunLifecycleState,
    pub count: usize,
}

impl EngineRunFleetProjection {
    /// Rebuild the fleet projection for one project from run records.
    ///
    /// Deterministic for the same records: rows sort by recency (updated_at
    /// descending), then run id ascending as the tie-breaker; counts follow
    /// lifecycle-state order.
    pub fn for_project(project_id: ProjectId, records: &[EngineRunStorageRecord]) -> Self {
        let mut runs: Vec<EngineRunFleetEntry> = records
            .iter()
            .filter(|record| record.project_id == project_id.0)
            .map(|record| EngineRunFleetEntry {
                run_id: record.run_id.0.clone(),
                state: record.state,
                provider_instance: record.provider_instance.clone(),
                provider_model: record.provider_model.clone(),
                orchestrator_designation: record.orchestrator_designation.clone(),
                updated_at: record.updated_at,
                has_closeout: record.closeout.is_some(),
            })
            .collect();
        runs.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| left.run_id.cmp(&right.run_id))
        });

        let mut state_counts = Vec::new();
        for state in [
            EngineRunLifecycleState::Proposed,
            EngineRunLifecycleState::Dispatched,
            EngineRunLifecycleState::Running,
            EngineRunLifecycleState::Delivered,
            EngineRunLifecycleState::Accepted,
            EngineRunLifecycleState::Rejected,
            EngineRunLifecycleState::Failed,
            EngineRunLifecycleState::Cancelled,
        ] {
            let count = runs.iter().filter(|run| run.state == state).count();
            if count > 0 {
                state_counts.push(EngineRunStateCount { state, count });
            }
        }

        Self {
            project_id,
            runs,
            state_counts,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::run_commands::{
        EngineRunBudgetEnvelope, EngineRunCloseout, EngineRunId, EngineRunObjective,
        EngineRunTransitionRecord,
    };

    fn record(run_id: &str, project_id: &str, state: EngineRunLifecycleState, updated_at: u64) -> EngineRunStorageRecord {
        EngineRunStorageRecord {
            run_id: EngineRunId(run_id.to_owned()),
            project_id: project_id.to_owned(),
            objective: EngineRunObjective {
                scope: "scope".to_owned(),
                acceptance: Vec::new(),
                stop_conditions: Vec::new(),
            },
            worktree_ref: None,
            provider_instance: format!("provider:{run_id}"),
            provider_model: "model".to_owned(),
            orchestrator_designation: None,
            operation_id: None,
            conversation_id: None,
            state,
            budget: EngineRunBudgetEnvelope::default(),
            closeout: if state == EngineRunLifecycleState::Delivered {
                Some(EngineRunCloseout {
                    summary: "done".to_owned(),
                    evidence_refs: Vec::new(),
                    diff_ref: None,
                })
            } else {
                None
            },
            transitions: vec![EngineRunTransitionRecord {
                command_id: format!("command:{run_id}"),
                from: None,
                to: state,
                at: updated_at,
            }],
            created_at: 1,
            updated_at,
        }
    }

    #[test]
    fn fleet_projection_scopes_and_orders_by_recency() {
        let records = vec![
            record("run:old", "project:1", EngineRunLifecycleState::Accepted, 10),
            record("run:new", "project:1", EngineRunLifecycleState::Running, 30),
            record("run:mid", "project:1", EngineRunLifecycleState::Delivered, 20),
            record("run:other-project", "project:2", EngineRunLifecycleState::Proposed, 99),
        ];

        let projection = EngineRunFleetProjection::for_project(
            ProjectId("project:1".to_owned()),
            &records,
        );

        let ids: Vec<&str> = projection.runs.iter().map(|run| run.run_id.as_str()).collect();
        assert_eq!(ids, vec!["run:new", "run:mid", "run:old"]);
        assert_eq!(projection.runs[0].has_closeout, false);
        assert_eq!(projection.runs[1].has_closeout, true);
        assert_eq!(
            projection.runs[1].state,
            EngineRunLifecycleState::Delivered
        );

        let counts: Vec<(EngineRunLifecycleState, usize)> = projection
            .state_counts
            .iter()
            .map(|count| (count.state, count.count))
            .collect();
        assert_eq!(
            counts,
            vec![
                (EngineRunLifecycleState::Running, 1),
                (EngineRunLifecycleState::Delivered, 1),
                (EngineRunLifecycleState::Accepted, 1),
            ]
        );
    }

    #[test]
    fn fleet_projection_is_deterministic_on_recency_tie() {
        let records = vec![
            record("run:b", "project:1", EngineRunLifecycleState::Proposed, 5),
            record("run:a", "project:1", EngineRunLifecycleState::Proposed, 5),
        ];

        let first = EngineRunFleetProjection::for_project(ProjectId("project:1".to_owned()), &records);
        let second = EngineRunFleetProjection::for_project(ProjectId("project:1".to_owned()), &records);

        let ids: Vec<&str> = first.runs.iter().map(|run| run.run_id.as_str()).collect();
        assert_eq!(ids, vec!["run:a", "run:b"]);
        assert_eq!(first, second);
    }

    #[test]
    fn fleet_projection_without_matching_runs_is_empty() {
        let records = vec![record("run:1", "project:1", EngineRunLifecycleState::Proposed, 1)];

        let projection = EngineRunFleetProjection::for_project(
            ProjectId("project:missing".to_owned()),
            &records,
        );

        assert_eq!(projection.runs, Vec::new());
        assert_eq!(projection.state_counts, Vec::new());
    }
}
