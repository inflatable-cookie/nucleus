//! Durable project goals and ordered task membership.

use std::collections::{HashMap, HashSet};
use std::time::SystemTime;

use nucleus_core::RevisionId;
use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

use crate::PlanningGoalId;

pub const MAX_GOAL_TASKS: usize = 50;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Goal {
    pub id: PlanningGoalId,
    pub project_id: ProjectId,
    pub title: String,
    pub desired_outcome: String,
    pub scope: String,
    pub status: GoalStatus,
    pub owner_refs: Vec<String>,
    pub ordered_task_refs: Vec<TaskId>,
    pub planning_artifact_refs: Vec<String>,
    pub provenance_refs: Vec<String>,
    pub stop_conditions: Vec<String>,
    pub evidence_refs: Vec<String>,
    pub current_next_task_ref: Option<TaskId>,
    pub next_action: Option<String>,
    pub timestamps: GoalTimestamps,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GoalStatus {
    Proposed,
    Ready,
    Active,
    Blocked { reason: String },
    Achieved,
    Abandoned,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GoalTimestamps {
    pub created_at: Option<SystemTime>,
    pub updated_at: Option<SystemTime>,
    pub achieved_at: Option<SystemTime>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GoalTaskCandidate {
    pub task_id: TaskId,
    pub project_id: ProjectId,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GoalMembershipChange {
    pub expected_revision: RevisionId,
    pub ordered_task_refs: Vec<TaskId>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GoalValidationError {
    pub reason: String,
}

pub fn validate_goal(
    goal: &Goal,
    task_candidates: &[GoalTaskCandidate],
) -> Result<(), GoalValidationError> {
    require_text("goal id", &goal.id.0)?;
    require_text("goal project id", &goal.project_id.0)?;
    require_text("goal title", &goal.title)?;
    require_text("goal desired outcome", &goal.desired_outcome)?;
    require_text("goal scope", &goal.scope)?;
    if goal.owner_refs.is_empty() {
        return invalid("goal requires at least one owner ref".to_owned());
    }
    require_non_empty_refs("goal owner refs", &goal.owner_refs)?;
    require_non_empty_refs("goal planning artifact refs", &goal.planning_artifact_refs)?;
    require_non_empty_refs("goal provenance refs", &goal.provenance_refs)?;
    require_non_empty_refs("goal stop conditions", &goal.stop_conditions)?;
    require_non_empty_refs("goal evidence refs", &goal.evidence_refs)?;
    if let Some(next_action) = goal.next_action.as_deref() {
        require_text("goal next action", next_action)?;
    }
    if goal.ordered_task_refs.len() > MAX_GOAL_TASKS {
        return invalid(format!(
            "goal task membership exceeds {MAX_GOAL_TASKS} tasks"
        ));
    }

    let mut seen = HashSet::new();
    for task_id in &goal.ordered_task_refs {
        require_text("goal task ref", &task_id.0)?;
        if !seen.insert(task_id.0.as_str()) {
            return invalid(format!("goal contains duplicate task ref: {}", task_id.0));
        }
    }

    let candidates = task_candidates
        .iter()
        .map(|candidate| (candidate.task_id.0.as_str(), candidate))
        .collect::<HashMap<_, _>>();
    for task_id in &goal.ordered_task_refs {
        let candidate = candidates
            .get(task_id.0.as_str())
            .ok_or_else(|| GoalValidationError {
                reason: format!("goal task ref is missing: {}", task_id.0),
            })?;
        if candidate.project_id != goal.project_id {
            return invalid(format!(
                "goal task belongs to another project: {}",
                task_id.0
            ));
        }
    }

    if let Some(next_task) = goal.current_next_task_ref.as_ref() {
        if !goal.ordered_task_refs.contains(next_task) {
            return invalid("goal next task must belong to the goal".to_owned());
        }
    }
    if let GoalStatus::Blocked { reason } = &goal.status {
        require_text("goal blocked reason", reason)?;
    }
    Ok(())
}

pub fn validate_goal_status_transition(
    from: &GoalStatus,
    to: &GoalStatus,
) -> Result<(), GoalValidationError> {
    let valid = same_status_kind(from, to)
        || matches!(
            (from, to),
            (
                GoalStatus::Proposed,
                GoalStatus::Ready | GoalStatus::Abandoned
            ) | (
                GoalStatus::Ready,
                GoalStatus::Active | GoalStatus::Blocked { .. } | GoalStatus::Abandoned
            ) | (
                GoalStatus::Active,
                GoalStatus::Blocked { .. } | GoalStatus::Achieved | GoalStatus::Abandoned
            ) | (
                GoalStatus::Blocked { .. },
                GoalStatus::Ready | GoalStatus::Active | GoalStatus::Abandoned
            )
        );
    if valid {
        Ok(())
    } else {
        invalid(format!(
            "invalid goal status transition: {from:?} -> {to:?}"
        ))
    }
}

pub fn apply_goal_membership_change(
    goal: &Goal,
    current_revision: &RevisionId,
    change: GoalMembershipChange,
    task_candidates: &[GoalTaskCandidate],
) -> Result<Goal, GoalValidationError> {
    if change.expected_revision != *current_revision {
        return invalid(format!("goal revision conflict for {}", goal.id.0));
    }
    let mut updated = goal.clone();
    updated.ordered_task_refs = change.ordered_task_refs;
    if updated
        .current_next_task_ref
        .as_ref()
        .is_some_and(|task| !updated.ordered_task_refs.contains(task))
    {
        updated.current_next_task_ref = updated.ordered_task_refs.first().cloned();
    }
    validate_goal(&updated, task_candidates)?;
    Ok(updated)
}

fn same_status_kind(left: &GoalStatus, right: &GoalStatus) -> bool {
    std::mem::discriminant(left) == std::mem::discriminant(right)
}

fn require_text(label: &str, value: &str) -> Result<(), GoalValidationError> {
    if value.trim().is_empty() {
        invalid(format!("{label} must not be empty"))
    } else {
        Ok(())
    }
}

fn require_non_empty_refs(label: &str, refs: &[String]) -> Result<(), GoalValidationError> {
    if refs.iter().any(|value| value.trim().is_empty()) {
        invalid(format!("{label} must not contain empty values"))
    } else {
        Ok(())
    }
}

fn invalid<T>(reason: String) -> Result<T, GoalValidationError> {
    Err(GoalValidationError { reason })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn goal_owns_ordered_same_project_task_membership() {
        let goal = fixture_goal(vec!["task:one", "task:two"]);
        let candidates = candidates(&["task:one", "task:two"], "project:nucleus");

        validate_goal(&goal, &candidates).expect("valid goal");
        assert_eq!(goal.ordered_task_refs[0].0, "task:one");
        assert_eq!(
            goal.current_next_task_ref,
            goal.ordered_task_refs.first().cloned()
        );
    }

    #[test]
    fn membership_rejects_duplicates_missing_and_cross_project_tasks() {
        let duplicate = fixture_goal(vec!["task:one", "task:one"]);
        assert!(
            validate_goal(&duplicate, &candidates(&["task:one"], "project:nucleus"))
                .expect_err("duplicate")
                .reason
                .contains("duplicate")
        );

        let missing = fixture_goal(vec!["task:missing"]);
        assert!(validate_goal(&missing, &[])
            .expect_err("missing")
            .reason
            .contains("missing"));

        let cross_project = fixture_goal(vec!["task:other"]);
        assert!(validate_goal(
            &cross_project,
            &candidates(&["task:other"], "project:other")
        )
        .expect_err("cross-project")
        .reason
        .contains("another project"));
    }

    #[test]
    fn membership_is_bounded_and_next_task_must_be_contained() {
        let mut oversized = fixture_goal(
            (0..=MAX_GOAL_TASKS)
                .map(|index| format!("task:{index}"))
                .collect::<Vec<_>>(),
        );
        let task_names = oversized
            .ordered_task_refs
            .iter()
            .map(|task| task.0.clone())
            .collect::<Vec<_>>();
        let candidates = task_names
            .iter()
            .map(|task| GoalTaskCandidate {
                task_id: TaskId(task.clone()),
                project_id: ProjectId("project:nucleus".to_owned()),
            })
            .collect::<Vec<_>>();
        assert!(validate_goal(&oversized, &candidates).is_err());

        oversized.ordered_task_refs.truncate(1);
        oversized.current_next_task_ref = Some(TaskId("task:outside".to_owned()));
        assert!(validate_goal(&oversized, &candidates[..1]).is_err());
    }

    #[test]
    fn goal_status_transitions_fail_closed() {
        validate_goal_status_transition(&GoalStatus::Proposed, &GoalStatus::Ready)
            .expect("proposed to ready");
        validate_goal_status_transition(
            &GoalStatus::Active,
            &GoalStatus::Blocked {
                reason: "needs input".to_owned(),
            },
        )
        .expect("active to blocked");
        assert!(
            validate_goal_status_transition(&GoalStatus::Achieved, &GoalStatus::Active).is_err()
        );
        assert!(
            validate_goal_status_transition(&GoalStatus::Proposed, &GoalStatus::Achieved).is_err()
        );
    }

    #[test]
    fn membership_change_requires_current_revision_and_revalidates_scope() {
        let goal = fixture_goal(vec!["task:one"]);
        let revision = RevisionId("rev:goal:1".to_owned());
        let task_candidates = candidates(&["task:one", "task:two"], "project:nucleus");
        let updated = apply_goal_membership_change(
            &goal,
            &revision,
            GoalMembershipChange {
                expected_revision: revision.clone(),
                ordered_task_refs: vec![
                    TaskId("task:two".to_owned()),
                    TaskId("task:one".to_owned()),
                ],
            },
            &task_candidates,
        )
        .expect("membership update");

        assert_eq!(updated.ordered_task_refs[0].0, "task:two");
        assert_eq!(
            updated.current_next_task_ref,
            Some(TaskId("task:one".to_owned()))
        );
        assert!(apply_goal_membership_change(
            &goal,
            &revision,
            GoalMembershipChange {
                expected_revision: RevisionId("rev:stale".to_owned()),
                ordered_task_refs: vec![TaskId("task:two".to_owned())],
            },
            &task_candidates,
        )
        .expect_err("stale revision")
        .reason
        .contains("revision conflict"));
    }

    fn fixture_goal(task_refs: Vec<impl Into<String>>) -> Goal {
        let ordered_task_refs = task_refs
            .into_iter()
            .map(|task| TaskId(task.into()))
            .collect::<Vec<_>>();
        Goal {
            id: PlanningGoalId("goal:nucleus:ship".to_owned()),
            project_id: ProjectId("project:nucleus".to_owned()),
            title: "Ship Nucleus".to_owned(),
            desired_outcome: "Nucleus can execute a goal-backed task runway.".to_owned(),
            scope: "Goal and task workflow foundation.".to_owned(),
            status: GoalStatus::Ready,
            owner_refs: vec!["operator:tom".to_owned()],
            current_next_task_ref: ordered_task_refs.first().cloned(),
            ordered_task_refs,
            planning_artifact_refs: vec![],
            provenance_refs: vec![],
            stop_conditions: vec!["Stop on blocked task".to_owned()],
            evidence_refs: vec![],
            next_action: Some("Run the first task".to_owned()),
            timestamps: GoalTimestamps {
                created_at: None,
                updated_at: None,
                achieved_at: None,
            },
        }
    }

    fn candidates(task_refs: &[&str], project_id: &str) -> Vec<GoalTaskCandidate> {
        task_refs
            .iter()
            .map(|task_id| GoalTaskCandidate {
                task_id: TaskId((*task_id).to_owned()),
                project_id: ProjectId(project_id.to_owned()),
            })
            .collect()
    }
}
