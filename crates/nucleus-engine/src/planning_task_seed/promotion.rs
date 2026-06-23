//! Task seed promotion command admission.

#[cfg(test)]
mod tests;

use nucleus_core::RevisionId;
use nucleus_projects::ProjectId;
use nucleus_tasks::{TaskActivityState, TaskId};

use super::{
    EnginePlanningArtifactId, EnginePlanningReviewState, EngineTaskSeedCandidateRecord,
    EngineTaskSeedId, EngineTaskSeedPromotionState,
};
use crate::EngineTaskCreateCommand;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineTaskSeedPromotionCommand {
    pub command_id: String,
    pub project_id: ProjectId,
    pub seed_id: EngineTaskSeedId,
    pub expected_seed_revision: Option<RevisionId>,
    pub destination_task_id: Option<TaskId>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineTaskSeedPromotionAdmission {
    pub command_id: String,
    pub project_id: ProjectId,
    pub seed_id: EngineTaskSeedId,
    pub source_artifact_id: Option<EnginePlanningArtifactId>,
    pub expected_seed_revision: Option<RevisionId>,
    pub task_id: TaskId,
    pub create_command: EngineTaskCreateCommand,
    pub provider_execution_deferred: bool,
    pub task_creation_performed: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EngineTaskSeedPromotionOutcome {
    Admitted(Box<EngineTaskSeedPromotionAdmission>),
    AlreadyPromoted {
        seed_id: EngineTaskSeedId,
        task_ref: String,
    },
    Blocked {
        seed_id: EngineTaskSeedId,
        reasons: Vec<String>,
    },
    Conflict {
        reason: String,
    },
    RepairRequired {
        seed_id: EngineTaskSeedId,
        task_ref: String,
        reason: String,
    },
}

pub fn admit_task_seed_promotion(
    command: EngineTaskSeedPromotionCommand,
    seed: &EngineTaskSeedCandidateRecord,
) -> EngineTaskSeedPromotionOutcome {
    if command.command_id.trim().is_empty() {
        return EngineTaskSeedPromotionOutcome::Conflict {
            reason: "task seed promotion requires a command id".to_owned(),
        };
    }
    if command.project_id != seed.project_id {
        return EngineTaskSeedPromotionOutcome::Conflict {
            reason: format!(
                "task seed project mismatch: command={} seed={}",
                command.project_id.0, seed.project_id.0
            ),
        };
    }
    if command.seed_id != seed.seed_id {
        return EngineTaskSeedPromotionOutcome::Conflict {
            reason: format!(
                "task seed id mismatch: command={} seed={}",
                command.seed_id.0, seed.seed_id.0
            ),
        };
    }

    if let EngineTaskSeedPromotionState::Promoted { task_ref } = &seed.promotion {
        if task_ref.trim().is_empty() {
            return EngineTaskSeedPromotionOutcome::RepairRequired {
                seed_id: seed.seed_id.clone(),
                task_ref: task_ref.clone(),
                reason: "promoted task seed has an empty task ref".to_owned(),
            };
        }
        return EngineTaskSeedPromotionOutcome::AlreadyPromoted {
            seed_id: seed.seed_id.clone(),
            task_ref: task_ref.clone(),
        };
    }

    let task_id = TaskId(format!("task:{}", command.command_id));
    if let Some(expected_task_id) = command.destination_task_id.as_ref() {
        if expected_task_id != &task_id {
            return EngineTaskSeedPromotionOutcome::Conflict {
                reason: format!(
                    "destination task id does not match promotion command id: expected={} actual={}",
                    expected_task_id.0, task_id.0
                ),
            };
        }
    }

    let blocked_reasons = blocked_reasons(seed);
    if !blocked_reasons.is_empty() {
        return EngineTaskSeedPromotionOutcome::Blocked {
            seed_id: seed.seed_id.clone(),
            reasons: blocked_reasons,
        };
    }

    let create_command = EngineTaskCreateCommand {
        project_id: seed.project_id.clone(),
        title: seed.title.clone(),
        description: Some(seed.problem_statement.clone()),
        acceptance_criteria: seed.acceptance_criteria_draft.clone(),
        importance: seed.suggested_importance.clone(),
        action_type: seed.suggested_action_type.clone(),
        activity: TaskActivityState::Proposed,
        agent_readiness: seed.agent_readiness_hints.suggested_readiness.clone(),
    };

    EngineTaskSeedPromotionOutcome::Admitted(Box::new(EngineTaskSeedPromotionAdmission {
        command_id: command.command_id,
        project_id: seed.project_id.clone(),
        seed_id: seed.seed_id.clone(),
        source_artifact_id: seed.source_artifact_id.clone(),
        expected_seed_revision: command.expected_seed_revision,
        task_id,
        create_command,
        provider_execution_deferred: true,
        task_creation_performed: false,
    }))
}

fn blocked_reasons(seed: &EngineTaskSeedCandidateRecord) -> Vec<String> {
    let mut reasons = Vec::new();

    match &seed.review {
        EnginePlanningReviewState::Accepted { .. } => {}
        EnginePlanningReviewState::Draft => {
            reasons.push("task seed is still draft planning output".to_owned());
        }
        EnginePlanningReviewState::ReviewRequested => {
            reasons.push("task seed is awaiting review".to_owned());
        }
        EnginePlanningReviewState::ChangesRequested { reason } => {
            reasons.push(format!("task seed changes requested: {reason}"));
        }
        EnginePlanningReviewState::Rejected { reason } => {
            reasons.push(format!("task seed was rejected: {reason}"));
        }
        EnginePlanningReviewState::Superseded => {
            reasons.push("task seed was superseded".to_owned());
        }
    }

    match &seed.promotion {
        EngineTaskSeedPromotionState::ReadyForPromotion => {}
        EngineTaskSeedPromotionState::NotReady { reason } => {
            reasons.push(format!("task seed is not ready for promotion: {reason}"));
        }
        EngineTaskSeedPromotionState::Reviewable => {
            reasons.push("task seed must be explicitly marked ready for promotion".to_owned());
        }
        EngineTaskSeedPromotionState::Blocked { reason } => {
            reasons.push(format!("task seed promotion is blocked: {reason}"));
        }
        EngineTaskSeedPromotionState::Promoted { .. } => {}
    }

    if seed.title.trim().is_empty() {
        reasons.push("task seed title must not be empty".to_owned());
    }
    if seed.title.trim().len() > 160 {
        reasons.push("task seed title must be 160 characters or fewer".to_owned());
    }
    if seed
        .agent_readiness_hints
        .suggested_readiness
        .ready_for_agent
        && seed.acceptance_criteria_draft.is_empty()
    {
        reasons.push(
            "agent-ready promoted tasks require at least one acceptance criterion".to_owned(),
        );
    }

    reasons.extend(
        seed.blocking_questions
            .iter()
            .map(|question| format!("blocking question: {question}")),
    );

    reasons
}
