//! Advisory task work-item transition candidates from live observations.
//!
//! These records map persisted provider observations to possible work-item
//! runtime states. They do not admit transitions or mutate task state.

use nucleus_engine::EngineTaskWorkItemId;
use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

use crate::codex_supervision::{
    CodexRuntimeObservationEventStorePersistenceRecord,
    CodexRuntimeObservationEventStorePersistenceStatus,
};

use super::CodexTaskRuntimeRequestRecord;

/// Input for deriving one work-item transition candidate.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexLiveObservationWorkItemCandidateInput {
    pub request: CodexTaskRuntimeRequestRecord,
    pub observation: CodexRuntimeObservationEventStorePersistenceRecord,
}

/// Advisory transition candidate for one task work item.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexLiveObservationWorkItemCandidate {
    pub candidate_id: String,
    pub task_id: TaskId,
    pub project_id: ProjectId,
    pub work_item_id: EngineTaskWorkItemId,
    pub provider_instance_id: String,
    pub runtime_session_ref: String,
    pub event_id: Option<String>,
    pub receipt_ref: Option<String>,
    pub frame_source_id: String,
    pub decode_outcome_id: String,
    pub candidate_state: CodexLiveObservationWorkItemCandidateState,
    pub status: CodexLiveObservationWorkItemCandidateStatus,
    pub blockers: Vec<CodexLiveObservationWorkItemCandidateBlocker>,
    pub evidence_refs: Vec<String>,
    pub advisory_only: bool,
    pub task_mutation_permitted: bool,
    pub raw_provider_material_retained: bool,
}

/// Candidate runtime state derived from provider observation evidence.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexLiveObservationWorkItemCandidateState {
    Running,
    Waiting,
    Completed,
    Failed,
    Cancelled,
    RecoveryRequired,
}

/// Candidate status before admission.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexLiveObservationWorkItemCandidateStatus {
    Candidate,
    Blocked,
}

/// Reasons a candidate cannot be trusted.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexLiveObservationWorkItemCandidateBlocker {
    MissingWorkItemIdentity,
    ObservationNotAccepted,
    ObservationRetainedRawProviderMaterial,
    ObservationPermitsTaskMutation,
}

/// Derive an advisory task work-item transition candidate.
pub fn codex_live_observation_work_item_candidate(
    input: CodexLiveObservationWorkItemCandidateInput,
) -> CodexLiveObservationWorkItemCandidate {
    let blockers = candidate_blockers(&input);
    let status = if blockers.is_empty() {
        CodexLiveObservationWorkItemCandidateStatus::Candidate
    } else {
        CodexLiveObservationWorkItemCandidateStatus::Blocked
    };
    let candidate_state = candidate_state(&input.observation);

    CodexLiveObservationWorkItemCandidate {
        candidate_id: format!(
            "codex-live-observation-work-item-candidate:{}:{}",
            input.request.work_item_id.0, input.observation.identity_id
        ),
        task_id: input.request.task_id,
        project_id: input.request.project_id,
        work_item_id: input.request.work_item_id,
        provider_instance_id: input.observation.provider_instance_id,
        runtime_session_ref: input.observation.runtime_session_ref,
        event_id: input.observation.event_id,
        receipt_ref: None,
        frame_source_id: input.observation.frame_source_id,
        decode_outcome_id: input.observation.decode_outcome_id,
        candidate_state,
        status,
        blockers,
        evidence_refs: input.observation.evidence_refs,
        advisory_only: true,
        task_mutation_permitted: false,
        raw_provider_material_retained: false,
    }
}

fn candidate_blockers(
    input: &CodexLiveObservationWorkItemCandidateInput,
) -> Vec<CodexLiveObservationWorkItemCandidateBlocker> {
    let mut blockers = Vec::new();
    if input.request.work_item_id.0.trim().is_empty() {
        blockers.push(CodexLiveObservationWorkItemCandidateBlocker::MissingWorkItemIdentity);
    }
    if !matches!(
        input.observation.status,
        CodexRuntimeObservationEventStorePersistenceStatus::Persisted
            | CodexRuntimeObservationEventStorePersistenceStatus::DuplicateNoop
    ) {
        blockers.push(CodexLiveObservationWorkItemCandidateBlocker::ObservationNotAccepted);
    }
    if input.observation.raw_provider_material_retained {
        blockers.push(
            CodexLiveObservationWorkItemCandidateBlocker::ObservationRetainedRawProviderMaterial,
        );
    }
    if input.observation.task_mutation_permitted {
        blockers.push(CodexLiveObservationWorkItemCandidateBlocker::ObservationPermitsTaskMutation);
    }
    blockers
}

fn candidate_state(
    observation: &CodexRuntimeObservationEventStorePersistenceRecord,
) -> CodexLiveObservationWorkItemCandidateState {
    if observation.status == CodexRuntimeObservationEventStorePersistenceStatus::RepairEvidenceOnly
        || observation.status == CodexRuntimeObservationEventStorePersistenceStatus::Blocked
    {
        return CodexLiveObservationWorkItemCandidateState::RecoveryRequired;
    }

    let method = observation.method.as_deref().unwrap_or_default();
    if method.contains("completed") {
        CodexLiveObservationWorkItemCandidateState::Completed
    } else if method.contains("failed") || method.contains("error") {
        CodexLiveObservationWorkItemCandidateState::Failed
    } else if method.contains("cancel") || method.contains("interrupt") {
        CodexLiveObservationWorkItemCandidateState::Cancelled
    } else if method.contains("callback")
        || method.contains("wait")
        || method.contains("permission")
    {
        CodexLiveObservationWorkItemCandidateState::Waiting
    } else {
        CodexLiveObservationWorkItemCandidateState::Running
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_task_runtime::{CodexTaskRuntimeProviderRefs, CodexTaskRuntimeRequestId};
    use crate::ids::ServerEventId;
    use nucleus_agent_protocol::{
        AdapterIdentity, AgentSessionId, AuthenticationPreflight, ProviderDriverKind,
        TransportFamily, VersionDiscovery,
    };
    use nucleus_command_policy::CommandRequestId;
    use nucleus_engine::{EngineTaskAgentWorkUnitSourceId, EngineTaskWorkItemId};

    #[test]
    fn live_observation_work_item_candidates_represent_runtime_states() {
        let cases = [
            (
                "turn/started",
                CodexLiveObservationWorkItemCandidateState::Running,
            ),
            (
                "provider/callback",
                CodexLiveObservationWorkItemCandidateState::Waiting,
            ),
            (
                "turn/completed",
                CodexLiveObservationWorkItemCandidateState::Completed,
            ),
            (
                "turn/failed",
                CodexLiveObservationWorkItemCandidateState::Failed,
            ),
            (
                "turn/cancelled",
                CodexLiveObservationWorkItemCandidateState::Cancelled,
            ),
        ];

        for (method, expected) in cases {
            let candidate = codex_live_observation_work_item_candidate(
                CodexLiveObservationWorkItemCandidateInput {
                    request: request("work:1"),
                    observation: observation(method),
                },
            );

            assert_eq!(candidate.candidate_state, expected);
            assert_eq!(
                candidate.status,
                CodexLiveObservationWorkItemCandidateStatus::Candidate
            );
            assert!(candidate.advisory_only);
            assert!(!candidate.task_mutation_permitted);
        }
    }

    #[test]
    fn live_observation_work_item_candidates_represent_recovery_required() {
        let mut observation = observation("turn/recovery-required");
        observation.status = CodexRuntimeObservationEventStorePersistenceStatus::RepairEvidenceOnly;

        let candidate = codex_live_observation_work_item_candidate(
            CodexLiveObservationWorkItemCandidateInput {
                request: request("work:1"),
                observation,
            },
        );

        assert_eq!(
            candidate.candidate_state,
            CodexLiveObservationWorkItemCandidateState::RecoveryRequired
        );
        assert_eq!(
            candidate.status,
            CodexLiveObservationWorkItemCandidateStatus::Blocked
        );
    }

    #[test]
    fn live_observation_work_item_candidates_block_missing_work_item_identity() {
        let candidate = codex_live_observation_work_item_candidate(
            CodexLiveObservationWorkItemCandidateInput {
                request: request(""),
                observation: observation("turn/completed"),
            },
        );

        assert_eq!(
            candidate.status,
            CodexLiveObservationWorkItemCandidateStatus::Blocked
        );
        assert!(candidate
            .blockers
            .contains(&CodexLiveObservationWorkItemCandidateBlocker::MissingWorkItemIdentity));
        assert!(!candidate.task_mutation_permitted);
    }

    #[test]
    fn live_observation_work_item_candidates_block_raw_provider_material() {
        let mut observation = observation("turn/completed");
        observation.raw_provider_material_retained = true;

        let candidate = codex_live_observation_work_item_candidate(
            CodexLiveObservationWorkItemCandidateInput {
                request: request("work:1"),
                observation,
            },
        );

        assert_eq!(
            candidate.status,
            CodexLiveObservationWorkItemCandidateStatus::Blocked
        );
        assert!(candidate.blockers.contains(
            &CodexLiveObservationWorkItemCandidateBlocker::ObservationRetainedRawProviderMaterial
        ));
        assert!(!candidate.raw_provider_material_retained);
    }

    fn request(work_item_id: &str) -> CodexTaskRuntimeRequestRecord {
        CodexTaskRuntimeRequestRecord {
            request_id: CodexTaskRuntimeRequestId("codex-task-runtime:1".to_owned()),
            project_id: ProjectId("project:1".to_owned()),
            task_id: TaskId("task:1".to_owned()),
            work_item_id: EngineTaskWorkItemId(work_item_id.to_owned()),
            source_id: EngineTaskAgentWorkUnitSourceId("source:1".to_owned()),
            adapter: AdapterIdentity {
                adapter_id: "adapter:codex".to_owned(),
                provider_driver_kind: ProviderDriverKind::Codex,
                provider_instance_id: "codex:local-default".to_owned(),
                provider_name: "OpenAI Codex".to_owned(),
                harness_name: "Codex app-server".to_owned(),
                transport_family: TransportFamily::StructuredAppServerRuntime,
                version_discovery: VersionDiscovery::Unsupported,
                authentication_preflight: AuthenticationPreflight::Unsupported,
            },
            command_request_id: CommandRequestId("command:1".to_owned()),
            event_id: ServerEventId("event:1".to_owned()),
            nucleus_session_id: AgentSessionId("session:nucleus".to_owned()),
            codex_refs: CodexTaskRuntimeProviderRefs::default(),
            summary: "task runtime request".to_owned(),
        }
    }

    fn observation(method: &str) -> CodexRuntimeObservationEventStorePersistenceRecord {
        CodexRuntimeObservationEventStorePersistenceRecord {
            persistence_id: "persistence:1".to_owned(),
            identity_id: format!("identity:{method}"),
            event_id: Some(format!("event:{method}")),
            command_id: "command:runtime:1".to_owned(),
            stream_ref: "stream:runtime:1".to_owned(),
            target_ref: "provider-session-binding:1".to_owned(),
            provider_instance_id: "codex:local-default".to_owned(),
            runtime_session_ref: "runtime-session:codex:1".to_owned(),
            binding_id: "provider-session-binding:1".to_owned(),
            frame_source_id: "frame:1".to_owned(),
            decode_outcome_id: "decode:1".to_owned(),
            method: Some(method.to_owned()),
            observation_kind: "CanonicalRuntimeEvent".to_owned(),
            status: CodexRuntimeObservationEventStorePersistenceStatus::Persisted,
            repair_hint: None,
            evidence_refs: vec!["evidence:observation".to_owned()],
            event_store_record: None,
            replay_runs_provider_work: false,
            raw_provider_material_retained: false,
            provider_io_executed: false,
            task_mutation_permitted: false,
        }
    }
}
