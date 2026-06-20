//! Replay-only task timeline projection from live observation admissions.
//!
//! These entries describe admitted runtime progress by reference. They do not
//! mutate task state or copy provider payloads.

use nucleus_engine::{EngineTaskTimelineEntryId, EngineTaskWorkItemId};
use nucleus_tasks::TaskId;

use super::{
    CodexWorkItemRuntimeTransitionAdmissionRecord, CodexWorkItemRuntimeTransitionAdmissionStatus,
};

/// Timeline entry projected from one admitted live-observation transition.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexLiveObservationTaskTimelineEntry {
    pub entry_id: EngineTaskTimelineEntryId,
    pub task_id: TaskId,
    pub work_item_id: EngineTaskWorkItemId,
    pub admission_id: String,
    pub previous_runtime: String,
    pub next_runtime: String,
    pub evidence_refs: Vec<String>,
    pub replay_only: bool,
    pub raw_provider_material_retained: bool,
    pub task_mutation_permitted: bool,
}

/// Read-only timeline projection from admitted live-observation transitions.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexLiveObservationTaskTimelineProjection {
    pub task_id: TaskId,
    pub entries: Vec<CodexLiveObservationTaskTimelineEntry>,
    pub provider_io_executed: bool,
    pub task_mutation_permitted: bool,
}

/// Rebuild timeline entries for one task from admitted observation transitions.
pub fn rebuild_codex_live_observation_task_timeline(
    task_id: TaskId,
    admissions: &[CodexWorkItemRuntimeTransitionAdmissionRecord],
) -> CodexLiveObservationTaskTimelineProjection {
    let mut sorted = admissions.to_vec();
    sorted.sort_by(|left, right| left.admission_id.cmp(&right.admission_id));

    let entries = sorted
        .into_iter()
        .filter(|admission| admission.task_id == task_id)
        .filter(|admission| {
            admission.status == CodexWorkItemRuntimeTransitionAdmissionStatus::Admitted
        })
        .map(|admission| CodexLiveObservationTaskTimelineEntry {
            entry_id: EngineTaskTimelineEntryId(format!(
                "timeline:{}:{}",
                admission.task_id.0, admission.admission_id
            )),
            task_id: admission.task_id,
            work_item_id: EngineTaskWorkItemId(admission.work_item_id),
            admission_id: admission.admission_id,
            previous_runtime: format!("{:?}", admission.previous_runtime),
            next_runtime: format!("{:?}", admission.next_runtime),
            evidence_refs: admission.evidence_refs,
            replay_only: true,
            raw_provider_material_retained: false,
            task_mutation_permitted: false,
        })
        .collect();

    CodexLiveObservationTaskTimelineProjection {
        task_id,
        entries,
        provider_io_executed: false,
        task_mutation_permitted: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_task_runtime::{
        CodexWorkItemRuntimeTransitionAdmissionBlocker,
        CodexWorkItemRuntimeTransitionAdmissionStatus,
    };
    use nucleus_engine::EngineTaskAgentWorkUnitRuntimeStatus;
    use nucleus_projects::ProjectId;

    #[test]
    fn live_observation_task_timeline_projection_is_deterministic() {
        let task_id = TaskId("task:1".to_owned());
        let admissions = vec![
            admission(
                "admission:2",
                "work:2",
                EngineTaskAgentWorkUnitRuntimeStatus::Completed,
            ),
            admission(
                "admission:1",
                "work:1",
                EngineTaskAgentWorkUnitRuntimeStatus::Running,
            ),
        ];

        let first = rebuild_codex_live_observation_task_timeline(task_id.clone(), &admissions);
        let second = rebuild_codex_live_observation_task_timeline(task_id, &admissions);

        assert_eq!(first, second);
        assert_eq!(first.entries.len(), 2);
        assert_eq!(first.entries[0].admission_id, "admission:1");
        assert_eq!(first.entries[1].admission_id, "admission:2");
        assert!(!first.provider_io_executed);
        assert!(!first.task_mutation_permitted);
    }

    #[test]
    fn live_observation_task_timeline_projection_skips_blocked_admissions() {
        let mut blocked = admission(
            "admission:blocked",
            "work:1",
            EngineTaskAgentWorkUnitRuntimeStatus::Completed,
        );
        blocked.status = CodexWorkItemRuntimeTransitionAdmissionStatus::Blocked;
        blocked
            .blockers
            .push(CodexWorkItemRuntimeTransitionAdmissionBlocker::InvalidRuntimeTransition);

        let projection =
            rebuild_codex_live_observation_task_timeline(TaskId("task:1".to_owned()), &[blocked]);

        assert!(projection.entries.is_empty());
    }

    #[test]
    fn live_observation_task_timeline_projection_contains_refs_without_raw_material() {
        let projection = rebuild_codex_live_observation_task_timeline(
            TaskId("task:1".to_owned()),
            &[admission(
                "admission:1",
                "work:1",
                EngineTaskAgentWorkUnitRuntimeStatus::Completed,
            )],
        );

        let entry = &projection.entries[0];
        assert_eq!(entry.evidence_refs, vec!["evidence:1"]);
        assert!(entry.replay_only);
        assert!(!entry.raw_provider_material_retained);
        assert!(!entry.task_mutation_permitted);
    }

    fn admission(
        admission_id: &str,
        work_item_id: &str,
        next_runtime: EngineTaskAgentWorkUnitRuntimeStatus,
    ) -> CodexWorkItemRuntimeTransitionAdmissionRecord {
        CodexWorkItemRuntimeTransitionAdmissionRecord {
            admission_id: admission_id.to_owned(),
            candidate_id: "candidate:1".to_owned(),
            task_id: TaskId("task:1".to_owned()),
            project_id: ProjectId("project:1".to_owned()),
            work_item_id: work_item_id.to_owned(),
            previous_runtime: EngineTaskAgentWorkUnitRuntimeStatus::Running,
            next_runtime,
            expected_revision_ref: Some("rev:1".to_owned()),
            status: CodexWorkItemRuntimeTransitionAdmissionStatus::Admitted,
            blockers: Vec::new(),
            evidence_refs: vec!["evidence:1".to_owned()],
            task_completion_permitted: false,
            review_acceptance_permitted: false,
            scm_mutation_permitted: false,
            task_state_mutation_permitted: false,
        }
    }
}
