//! Deterministic task readiness candidate projection.

use nucleus_projects::ProjectId;
use nucleus_tasks::{Task, TaskActionType, TaskActivityState, TaskId};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineTaskReadinessProjection {
    pub project_id: ProjectId,
    pub candidates: Vec<EngineTaskReadinessCandidate>,
    pub status_counts: Vec<EngineTaskReadinessStatusCount>,
    pub source_counts: EngineTaskReadinessSourceCounts,
    pub client_can_mutate: bool,
    pub provider_execution_available: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineTaskReadinessCandidate {
    pub task_id: TaskId,
    pub project_id: ProjectId,
    pub title: String,
    pub action_type: TaskActionType,
    pub activity: TaskActivityState,
    pub readiness: EngineTaskReadinessClass,
    pub reasons: Vec<String>,
    pub blocker_refs: Vec<String>,
    pub evidence_refs: Vec<String>,
    pub agent_ready: bool,
    pub validation_commands: Vec<String>,
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum EngineTaskReadinessClass {
    AgentDelegationReady,
    HumanPlanningReady,
    ActiveWorkPresent,
    AwaitingReview,
    Blocked,
    RepairRequired,
    Completed,
    Archived,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineTaskReadinessStatusCount {
    pub readiness: EngineTaskReadinessClass,
    pub count: usize,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct EngineTaskReadinessSourceCounts {
    pub task_records: usize,
    pub work_item_evidence_refs: usize,
    pub timeline_evidence_refs: usize,
    pub validation_command_refs: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineTaskReadinessInput {
    pub task_id: TaskId,
    pub project_id: ProjectId,
    pub title: String,
    pub action_type: TaskActionType,
    pub activity: TaskActivityState,
    pub agent_ready: bool,
    pub required_context_refs: Vec<String>,
    pub validation_commands: Vec<String>,
    pub work_item_evidence_refs: Vec<String>,
    pub timeline_evidence_refs: Vec<String>,
    pub blocker_refs: Vec<String>,
}

impl EngineTaskReadinessProjection {
    pub fn from_tasks(
        project_id: ProjectId,
        tasks: impl IntoIterator<Item = EngineTaskReadinessInput>,
    ) -> Self {
        let mut candidates = tasks
            .into_iter()
            .filter(|task| task.project_id == project_id)
            .map(EngineTaskReadinessCandidate::from_input)
            .collect::<Vec<_>>();

        candidates.sort_by(|left, right| {
            left.task_id
                .0
                .cmp(&right.task_id.0)
                .then_with(|| left.title.cmp(&right.title))
        });

        let mut projection = Self {
            project_id,
            candidates,
            status_counts: Vec::new(),
            source_counts: EngineTaskReadinessSourceCounts::default(),
            client_can_mutate: false,
            provider_execution_available: false,
        };
        projection.recount();
        projection
    }

    fn recount(&mut self) {
        let mut status_counts = Vec::<EngineTaskReadinessStatusCount>::new();
        let mut source_counts = EngineTaskReadinessSourceCounts {
            task_records: self.candidates.len(),
            ..EngineTaskReadinessSourceCounts::default()
        };

        for candidate in &self.candidates {
            match status_counts
                .iter_mut()
                .find(|count| count.readiness == candidate.readiness)
            {
                Some(count) => count.count += 1,
                None => status_counts.push(EngineTaskReadinessStatusCount {
                    readiness: candidate.readiness.clone(),
                    count: 1,
                }),
            }

            source_counts.validation_command_refs += candidate.validation_commands.len();
            source_counts.work_item_evidence_refs += candidate
                .evidence_refs
                .iter()
                .filter(|reference| reference.starts_with("work-item:"))
                .count();
            source_counts.timeline_evidence_refs += candidate
                .evidence_refs
                .iter()
                .filter(|reference| reference.starts_with("timeline:"))
                .count();
        }

        status_counts.sort_by(|left, right| left.readiness.cmp(&right.readiness));
        self.status_counts = status_counts;
        self.source_counts = source_counts;
    }
}

impl EngineTaskReadinessCandidate {
    fn from_input(input: EngineTaskReadinessInput) -> Self {
        let readiness = classify(&input);
        let reasons = reasons_for(&readiness, &input);
        let mut evidence_refs = Vec::new();
        evidence_refs.extend(input.work_item_evidence_refs.clone());
        evidence_refs.extend(input.timeline_evidence_refs.clone());

        Self {
            task_id: input.task_id,
            project_id: input.project_id,
            title: input.title,
            action_type: input.action_type,
            activity: input.activity,
            reasons,
            blocker_refs: input.blocker_refs,
            evidence_refs,
            agent_ready: input.agent_ready,
            validation_commands: input.validation_commands,
            readiness,
        }
    }
}

impl From<&Task> for EngineTaskReadinessInput {
    fn from(task: &Task) -> Self {
        let blocker_refs = match &task.activity {
            TaskActivityState::Blocked(reason) => vec![format!("task-blocker:{}", reason)],
            _ => Vec::new(),
        };

        Self {
            task_id: task.id.clone(),
            project_id: task.project_id.clone(),
            title: task.title.clone(),
            action_type: task.action_type.clone(),
            activity: task.activity.clone(),
            agent_ready: task.agent_readiness.ready_for_agent,
            required_context_refs: task.agent_readiness.required_context_refs.clone(),
            validation_commands: task.agent_readiness.validation_commands.clone(),
            work_item_evidence_refs: Vec::new(),
            timeline_evidence_refs: Vec::new(),
            blocker_refs,
        }
    }
}

fn classify(input: &EngineTaskReadinessInput) -> EngineTaskReadinessClass {
    if !input.blocker_refs.is_empty() && !matches!(input.activity, TaskActivityState::Blocked(_)) {
        return EngineTaskReadinessClass::RepairRequired;
    }

    match &input.activity {
        TaskActivityState::Archived => EngineTaskReadinessClass::Archived,
        TaskActivityState::Done => EngineTaskReadinessClass::Completed,
        TaskActivityState::Blocked(_) => EngineTaskReadinessClass::Blocked,
        TaskActivityState::Active => EngineTaskReadinessClass::ActiveWorkPresent,
        TaskActivityState::Ready if has_review_evidence(input) => {
            EngineTaskReadinessClass::AwaitingReview
        }
        TaskActivityState::Ready if input.agent_ready => {
            EngineTaskReadinessClass::AgentDelegationReady
        }
        TaskActivityState::Ready | TaskActivityState::Proposed => {
            EngineTaskReadinessClass::HumanPlanningReady
        }
    }
}

fn has_review_evidence(input: &EngineTaskReadinessInput) -> bool {
    input
        .work_item_evidence_refs
        .iter()
        .any(|reference| reference.contains("review"))
}

fn reasons_for(
    readiness: &EngineTaskReadinessClass,
    input: &EngineTaskReadinessInput,
) -> Vec<String> {
    match readiness {
        EngineTaskReadinessClass::AgentDelegationReady => vec![
            "task is marked ready".to_owned(),
            "agent readiness is true".to_owned(),
        ],
        EngineTaskReadinessClass::HumanPlanningReady => {
            vec!["task needs human planning or readiness review".to_owned()]
        }
        EngineTaskReadinessClass::ActiveWorkPresent => {
            vec!["task activity is active".to_owned()]
        }
        EngineTaskReadinessClass::AwaitingReview => {
            vec!["work-item review evidence is present".to_owned()]
        }
        EngineTaskReadinessClass::Blocked => vec!["task activity is blocked".to_owned()],
        EngineTaskReadinessClass::RepairRequired => {
            vec!["blocker refs require repair before selection".to_owned()]
        }
        EngineTaskReadinessClass::Completed => vec!["task activity is done".to_owned()],
        EngineTaskReadinessClass::Archived => vec!["task activity is archived".to_owned()],
    }
    .into_iter()
    .chain(
        input
            .required_context_refs
            .iter()
            .map(|reference| format!("context ref: {reference}")),
    )
    .collect()
}

#[cfg(test)]
mod tests;
