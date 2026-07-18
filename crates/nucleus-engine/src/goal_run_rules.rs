//! Pure goal-run workflow decisions.
//!
//! Prompt composition, work-item identity, action parsing, and
//! pre-dispatch validation for goal runs — no provider process, no
//! storage. Hosts map their task DTOs into [`EngineGoalRunTaskView`] and
//! call these rules; provider IO stays host-side.

use nucleus_tasks::TaskActionType;

/// Host-neutral view of the task a goal run is about to execute.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineGoalRunTaskView {
    pub task_id: String,
    pub revision_id: String,
    pub title: String,
    pub description: Option<String>,
    pub action_type: String,
    pub activity: String,
    pub agent_ready: bool,
    pub acceptance_criteria: Vec<String>,
    pub validation_commands: Vec<String>,
    pub stop_conditions: Vec<String>,
}

/// Rework context carried from an operator review decision.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineGoalRunReworkContext {
    pub decision_ref: String,
    pub reason: Option<String>,
    pub reviewed_work_item_refs: Vec<String>,
    pub reviewed_evidence_refs: Vec<String>,
}

/// Compose the provider prompt for one goal-run task. Opaque refs stay
/// opaque; patch content never enters the prompt.
pub fn goal_run_task_prompt(
    goal_id: Option<&str>,
    ordinal: usize,
    task: &EngineGoalRunTaskView,
    rework: Option<&EngineGoalRunReworkContext>,
) -> String {
    let criteria = task
        .acceptance_criteria
        .iter()
        .map(|criterion| format!("- {criterion}"))
        .collect::<Vec<_>>()
        .join("\n");
    let rework = rework
        .map(|context| {
            format!(
                "\n\nRework this reviewed result.\nReview decision: {}\nReview note: {}\nReviewed work items: {}\nReviewed evidence: {}\nAddress the review note while preserving unrelated existing work. Do not treat these opaque refs as file paths or patch content.",
                context.decision_ref,
                context.reason.as_deref().unwrap_or("No review note supplied."),
                context.reviewed_work_item_refs.join(", "),
                context.reviewed_evidence_refs.join(", ")
            )
        })
        .unwrap_or_default();
    format!(
        "Execute this Nucleus task as position {} in {}.\n\nTitle: {}\nDescription: {}\nAction: {}\nAcceptance criteria:\n{}\nValidation commands:\n{}\nTask stop conditions:\n{}{}\n\nMake the required workspace changes and run proportionate validation. Do not complete or otherwise mutate the Nucleus task record. End with a concise result summary.",
        ordinal + 1,
        goal_id
            .map(|goal_id| format!("Goal {goal_id}"))
            .unwrap_or_else(|| "the explicit single-task scope".to_owned()),
        task.title,
        task.description.as_deref().unwrap_or("No description supplied."),
        task.action_type,
        criteria,
        task.validation_commands.join("\n"),
        task.stop_conditions.join("\n"),
        rework
    )
}

/// Stable work-item identity for one goal-run task.
pub fn goal_run_work_item_id(plan_id: &str, task_id: &str) -> String {
    format!("work-item:goal-run:{plan_id}:{task_id}")
}

/// Parse a stored action-type label into the task action enum.
pub fn parse_task_action(value: &str) -> Result<TaskActionType, String> {
    match value {
        "research" => Ok(TaskActionType::Research),
        "plan" => Ok(TaskActionType::Plan),
        "execute" => Ok(TaskActionType::Execute),
        "test" => Ok(TaskActionType::Test),
        "check" => Ok(TaskActionType::Check),
        "review" => Ok(TaskActionType::Review),
        other => Err(format!("unsupported task action type: {other}")),
    }
}

/// A task may execute only at its admitted revision and while still ready
/// for agent execution.
pub fn validate_goal_run_task(
    admitted_revision: &str,
    task: &EngineGoalRunTaskView,
) -> Result<(), String> {
    if task.revision_id != admitted_revision {
        return Err(format!(
            "task changed after Goal run admission: {}",
            task.task_id
        ));
    }
    if task.activity != "ready" || !task.agent_ready {
        return Err(format!(
            "task is no longer ready for agent execution: {}",
            task.task_id
        ));
    }
    Ok(())
}

/// A goal continues a run only from ready or active status.
pub fn validate_goal_continuation_status(status: &str) -> Result<(), String> {
    if matches!(status, "ready" | "active") {
        Ok(())
    } else {
        Err(format!("Goal cannot continue from status {status}"))
    }
}

/// A mandate authorizes the next task only at its admitted revision, while
/// active, and before expiry.
pub fn validate_goal_run_mandate(
    revision_matches: bool,
    active: bool,
    now_epoch_seconds: u64,
    expires_at_epoch_seconds: u64,
) -> Result<(), String> {
    if !revision_matches || !active {
        return Err("goal run mandate is no longer active at its admitted revision".to_owned());
    }
    if now_epoch_seconds >= expires_at_epoch_seconds {
        return Err("goal run mandate expired before the next task".to_owned());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn view() -> EngineGoalRunTaskView {
        EngineGoalRunTaskView {
            task_id: "task:1".to_owned(),
            revision_id: "rev:1".to_owned(),
            title: "Wire the panel".to_owned(),
            description: None,
            action_type: "execute".to_owned(),
            activity: "ready".to_owned(),
            agent_ready: true,
            acceptance_criteria: vec!["panel renders".to_owned()],
            validation_commands: vec!["cargo test".to_owned()],
            stop_conditions: vec!["stop on red".to_owned()],
        }
    }

    #[test]
    fn prompt_includes_task_facts_and_rework_note_without_patch_content() {
        let rework = EngineGoalRunReworkContext {
            decision_ref: "decision:1".to_owned(),
            reason: Some("tighten validation".to_owned()),
            reviewed_work_item_refs: vec!["work:1".to_owned()],
            reviewed_evidence_refs: vec!["evidence:1".to_owned()],
        };
        let prompt = goal_run_task_prompt(Some("goal:1"), 1, &view(), Some(&rework));

        assert!(prompt.contains("position 2 in Goal goal:1"));
        assert!(prompt.contains("- panel renders"));
        assert!(prompt.contains("Review decision: decision:1"));
        assert!(prompt.contains("Do not treat these opaque refs as file paths"));
        assert!(!prompt.contains("diff --git"));
    }

    #[test]
    fn task_validation_rejects_revision_drift_and_unready_tasks() {
        assert!(validate_goal_run_task("rev:1", &view()).is_ok());
        assert!(validate_goal_run_task("rev:0", &view()).is_err());

        let mut unready = view();
        unready.agent_ready = false;
        assert!(validate_goal_run_task("rev:1", &unready).is_err());
    }

    #[test]
    fn continuation_and_mandate_rules_hold() {
        assert!(validate_goal_continuation_status("ready").is_ok());
        assert!(validate_goal_continuation_status("achieved").is_err());
        assert!(validate_goal_run_mandate(true, true, 10, 20).is_ok());
        assert!(validate_goal_run_mandate(true, true, 20, 20).is_err());
        assert!(validate_goal_run_mandate(false, true, 10, 20).is_err());
    }

    #[test]
    fn action_parse_and_work_item_identity_are_stable() {
        assert_eq!(parse_task_action("test"), Ok(TaskActionType::Test));
        assert!(parse_task_action("deploy").is_err());
        assert_eq!(
            goal_run_work_item_id("plan:1", "task:1"),
            "work-item:goal-run:plan:1:task:1"
        );
    }
}
