//! Task-backed Codex live execution policy records.
//!
//! These records decide whether a task work item may enter the Codex live
//! executor path. They do not execute provider writes, mutate task or review
//! state, retain raw provider material, or widen callback/cancel/resume
//! authority.

use crate::host_authority::EngineHostId;

use nucleus_engine::EngineTaskWorkItemId;
use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

const MAX_NON_PORTAL_FLAT_TOOL_COUNT: usize = 3;

/// Stable id for one task-backed Codex live execution policy record.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CodexAppServerTaskBackedLiveExecutionPolicyId(pub String);

/// Input for assessing a task-backed Codex live executor admission gate.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerTaskBackedLiveExecutionPolicyInput {
    pub work_item_id: EngineTaskWorkItemId,
    pub task_id: TaskId,
    pub project_id: ProjectId,
    pub provider_instance_id: String,
    pub runtime_session_ref: Option<String>,
    pub adapter_id: String,
    pub execution_host_id: EngineHostId,
    pub operator_evidence_ref: Option<String>,
    pub pathway_evidence: CodexAppServerTaskBackedLiveExecutionPathwayEvidence,
    pub tool_policy: CodexAppServerTaskBackedLiveExecutionToolPolicy,
    pub callback_response_requested: bool,
    pub cancellation_requested: bool,
    pub resume_requested: bool,
    pub task_completion_requested: bool,
    pub review_acceptance_requested: bool,
    pub scm_mutation_requested: bool,
    pub raw_provider_material_requested: bool,
}

/// Evidence that the live attempt came from a known planning pathway.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerTaskBackedLiveExecutionPathwayEvidence {
    RoadmapReadyCard {
        roadmap_ref: String,
        card_ref: String,
        evidence_ref: String,
    },
    TaskQueue {
        queue_ref: String,
        evidence_ref: String,
    },
    GoalLoop {
        goal_ref: String,
        loop_ref: String,
        evidence_ref: String,
    },
    PlanningArtifact {
        artifact_ref: String,
        evidence_ref: String,
    },
    RecoveryPath {
        recovery_ref: String,
        evidence_ref: String,
    },
    ValidationRepair {
        validation_ref: String,
        evidence_ref: String,
    },
    OperatorInstruction {
        instruction_ref: String,
        evidence_ref: String,
    },
    Missing,
}

/// Tool projection policy for a task-backed Codex live execution attempt.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerTaskBackedLiveExecutionToolPolicy {
    pub projection_mode: CodexAppServerTaskBackedLiveExecutionToolProjectionMode,
    pub adapter_capability_evidence_ref: Option<String>,
    pub portal_tool_family: Option<String>,
    pub published_actions: Vec<String>,
    pub flat_tool_count: usize,
}

/// Supported ways Nucleus may project tools into a bridged harness.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerTaskBackedLiveExecutionToolProjectionMode {
    PortalTool,
    NativeToolRegistration,
    McpToolServer,
    AcpToolSurface,
    SdkSidecar,
    PromptSkill,
    SidecarExecution,
    Unavailable,
}

/// Task-backed live execution policy decision.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerTaskBackedLiveExecutionPolicyRecord {
    pub policy_id: CodexAppServerTaskBackedLiveExecutionPolicyId,
    pub work_item_id: EngineTaskWorkItemId,
    pub task_id: TaskId,
    pub project_id: ProjectId,
    pub provider_instance_id: String,
    pub runtime_session_ref: Option<String>,
    pub adapter_id: String,
    pub execution_host_id: EngineHostId,
    pub status: CodexAppServerTaskBackedLiveExecutionPolicyStatus,
    pub blockers: Vec<CodexAppServerTaskBackedLiveExecutionPolicyBlocker>,
    pub pathway_evidence: CodexAppServerTaskBackedLiveExecutionPathwayEvidence,
    pub tool_policy: CodexAppServerTaskBackedLiveExecutionToolPolicy,
    pub evidence_refs: Vec<String>,
    pub provider_write_executed: bool,
    pub callback_response_permitted: bool,
    pub cancellation_permitted: bool,
    pub resume_permitted: bool,
    pub task_completion_permitted: bool,
    pub review_acceptance_permitted: bool,
    pub scm_mutation_permitted: bool,
    pub raw_provider_material_retained: bool,
}

/// Policy status for task-backed live execution.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerTaskBackedLiveExecutionPolicyStatus {
    AcceptedForLiveExecutorAdmission,
    Blocked,
}

/// Why a task work item cannot enter the Codex live executor path.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerTaskBackedLiveExecutionPolicyBlocker {
    MissingWorkItemId,
    MissingTaskId,
    MissingProjectId,
    MissingProviderInstanceId,
    MissingRuntimeSessionRef,
    MissingAdapterId,
    MissingExecutionHostId,
    MissingOperatorEvidence,
    MissingPathwayEvidence,
    MissingAdapterCapabilityEvidence,
    ToolProjectionUnavailable,
    MissingPortalToolFamily,
    MissingPublishedToolAction,
    FlatToolMenuRequested { flat_tool_count: usize },
    CallbackResponseRequested,
    CancellationRequested,
    ResumeRequested,
    TaskCompletionRequested,
    ReviewAcceptanceRequested,
    ScmMutationRequested,
    RawProviderMaterialRequested,
}

/// Assess the task-backed Codex live execution gate without executing I/O.
pub fn codex_task_backed_live_execution_policy(
    input: CodexAppServerTaskBackedLiveExecutionPolicyInput,
) -> CodexAppServerTaskBackedLiveExecutionPolicyRecord {
    let mut blockers = Vec::new();
    let mut evidence_refs = Vec::new();

    validate_required_identity(&input, &mut blockers, &mut evidence_refs);
    validate_pathway(&input.pathway_evidence, &mut blockers, &mut evidence_refs);
    validate_tool_policy(&input.tool_policy, &mut blockers, &mut evidence_refs);
    validate_forbidden_authority_requests(&input, &mut blockers);

    evidence_refs.sort();
    evidence_refs.dedup();

    let status = if blockers.is_empty() {
        CodexAppServerTaskBackedLiveExecutionPolicyStatus::AcceptedForLiveExecutorAdmission
    } else {
        CodexAppServerTaskBackedLiveExecutionPolicyStatus::Blocked
    };

    CodexAppServerTaskBackedLiveExecutionPolicyRecord {
        policy_id: CodexAppServerTaskBackedLiveExecutionPolicyId(format!(
            "codex-task-backed-live-execution-policy:{}",
            input.work_item_id.0
        )),
        work_item_id: input.work_item_id,
        task_id: input.task_id,
        project_id: input.project_id,
        provider_instance_id: input.provider_instance_id,
        runtime_session_ref: input.runtime_session_ref,
        adapter_id: input.adapter_id,
        execution_host_id: input.execution_host_id,
        status,
        blockers,
        pathway_evidence: input.pathway_evidence,
        tool_policy: input.tool_policy,
        evidence_refs,
        provider_write_executed: false,
        callback_response_permitted: false,
        cancellation_permitted: false,
        resume_permitted: false,
        task_completion_permitted: false,
        review_acceptance_permitted: false,
        scm_mutation_permitted: false,
        raw_provider_material_retained: false,
    }
}

fn validate_required_identity(
    input: &CodexAppServerTaskBackedLiveExecutionPolicyInput,
    blockers: &mut Vec<CodexAppServerTaskBackedLiveExecutionPolicyBlocker>,
    evidence_refs: &mut Vec<String>,
) {
    if input.work_item_id.0.is_empty() {
        blockers.push(CodexAppServerTaskBackedLiveExecutionPolicyBlocker::MissingWorkItemId);
    }
    if input.task_id.0.is_empty() {
        blockers.push(CodexAppServerTaskBackedLiveExecutionPolicyBlocker::MissingTaskId);
    }
    if input.project_id.0.is_empty() {
        blockers.push(CodexAppServerTaskBackedLiveExecutionPolicyBlocker::MissingProjectId);
    }
    if input.provider_instance_id.is_empty() {
        blockers
            .push(CodexAppServerTaskBackedLiveExecutionPolicyBlocker::MissingProviderInstanceId);
    }
    match &input.runtime_session_ref {
        Some(runtime_session_ref) if !runtime_session_ref.is_empty() => {
            evidence_refs.push(runtime_session_ref.clone());
        }
        _ => {
            blockers
                .push(CodexAppServerTaskBackedLiveExecutionPolicyBlocker::MissingRuntimeSessionRef);
        }
    }
    if input.adapter_id.is_empty() {
        blockers.push(CodexAppServerTaskBackedLiveExecutionPolicyBlocker::MissingAdapterId);
    }
    if input.execution_host_id.0.is_empty() {
        blockers.push(CodexAppServerTaskBackedLiveExecutionPolicyBlocker::MissingExecutionHostId);
    }
    match &input.operator_evidence_ref {
        Some(operator_evidence_ref) if !operator_evidence_ref.is_empty() => {
            evidence_refs.push(operator_evidence_ref.clone());
        }
        _ => blockers
            .push(CodexAppServerTaskBackedLiveExecutionPolicyBlocker::MissingOperatorEvidence),
    }
}

fn validate_pathway(
    pathway: &CodexAppServerTaskBackedLiveExecutionPathwayEvidence,
    blockers: &mut Vec<CodexAppServerTaskBackedLiveExecutionPolicyBlocker>,
    evidence_refs: &mut Vec<String>,
) {
    match pathway {
        CodexAppServerTaskBackedLiveExecutionPathwayEvidence::Missing => blockers
            .push(CodexAppServerTaskBackedLiveExecutionPolicyBlocker::MissingPathwayEvidence),
        CodexAppServerTaskBackedLiveExecutionPathwayEvidence::RoadmapReadyCard {
            roadmap_ref,
            card_ref,
            evidence_ref,
        } => collect_pathway_refs(
            &[roadmap_ref, card_ref, evidence_ref],
            blockers,
            evidence_refs,
        ),
        CodexAppServerTaskBackedLiveExecutionPathwayEvidence::TaskQueue {
            queue_ref,
            evidence_ref,
        } => collect_pathway_refs(&[queue_ref, evidence_ref], blockers, evidence_refs),
        CodexAppServerTaskBackedLiveExecutionPathwayEvidence::GoalLoop {
            goal_ref,
            loop_ref,
            evidence_ref,
        } => collect_pathway_refs(&[goal_ref, loop_ref, evidence_ref], blockers, evidence_refs),
        CodexAppServerTaskBackedLiveExecutionPathwayEvidence::PlanningArtifact {
            artifact_ref,
            evidence_ref,
        } => collect_pathway_refs(&[artifact_ref, evidence_ref], blockers, evidence_refs),
        CodexAppServerTaskBackedLiveExecutionPathwayEvidence::RecoveryPath {
            recovery_ref,
            evidence_ref,
        } => collect_pathway_refs(&[recovery_ref, evidence_ref], blockers, evidence_refs),
        CodexAppServerTaskBackedLiveExecutionPathwayEvidence::ValidationRepair {
            validation_ref,
            evidence_ref,
        } => collect_pathway_refs(&[validation_ref, evidence_ref], blockers, evidence_refs),
        CodexAppServerTaskBackedLiveExecutionPathwayEvidence::OperatorInstruction {
            instruction_ref,
            evidence_ref,
        } => collect_pathway_refs(&[instruction_ref, evidence_ref], blockers, evidence_refs),
    }
}

fn collect_pathway_refs(
    refs: &[&String],
    blockers: &mut Vec<CodexAppServerTaskBackedLiveExecutionPolicyBlocker>,
    evidence_refs: &mut Vec<String>,
) {
    if refs.iter().any(|value| value.is_empty()) {
        blockers.push(CodexAppServerTaskBackedLiveExecutionPolicyBlocker::MissingPathwayEvidence);
        return;
    }
    evidence_refs.extend(refs.iter().map(|value| (*value).clone()));
}

fn validate_tool_policy(
    tool_policy: &CodexAppServerTaskBackedLiveExecutionToolPolicy,
    blockers: &mut Vec<CodexAppServerTaskBackedLiveExecutionPolicyBlocker>,
    evidence_refs: &mut Vec<String>,
) {
    match &tool_policy.adapter_capability_evidence_ref {
        Some(evidence_ref) if !evidence_ref.is_empty() => evidence_refs.push(evidence_ref.clone()),
        _ => blockers.push(
            CodexAppServerTaskBackedLiveExecutionPolicyBlocker::MissingAdapterCapabilityEvidence,
        ),
    }

    if tool_policy.projection_mode
        == CodexAppServerTaskBackedLiveExecutionToolProjectionMode::Unavailable
    {
        blockers
            .push(CodexAppServerTaskBackedLiveExecutionPolicyBlocker::ToolProjectionUnavailable);
    }
    if tool_policy.published_actions.is_empty()
        || tool_policy
            .published_actions
            .iter()
            .any(|action| action.is_empty())
    {
        blockers
            .push(CodexAppServerTaskBackedLiveExecutionPolicyBlocker::MissingPublishedToolAction);
    }

    match tool_policy.projection_mode {
        CodexAppServerTaskBackedLiveExecutionToolProjectionMode::PortalTool => {
            match &tool_policy.portal_tool_family {
                Some(family) if !family.is_empty() => evidence_refs.push(format!("tool:{family}")),
                _ => blockers.push(
                    CodexAppServerTaskBackedLiveExecutionPolicyBlocker::MissingPortalToolFamily,
                ),
            }
        }
        _ if tool_policy.flat_tool_count > MAX_NON_PORTAL_FLAT_TOOL_COUNT => blockers.push(
            CodexAppServerTaskBackedLiveExecutionPolicyBlocker::FlatToolMenuRequested {
                flat_tool_count: tool_policy.flat_tool_count,
            },
        ),
        _ => {}
    }
}

fn validate_forbidden_authority_requests(
    input: &CodexAppServerTaskBackedLiveExecutionPolicyInput,
    blockers: &mut Vec<CodexAppServerTaskBackedLiveExecutionPolicyBlocker>,
) {
    if input.callback_response_requested {
        blockers
            .push(CodexAppServerTaskBackedLiveExecutionPolicyBlocker::CallbackResponseRequested);
    }
    if input.cancellation_requested {
        blockers.push(CodexAppServerTaskBackedLiveExecutionPolicyBlocker::CancellationRequested);
    }
    if input.resume_requested {
        blockers.push(CodexAppServerTaskBackedLiveExecutionPolicyBlocker::ResumeRequested);
    }
    if input.task_completion_requested {
        blockers.push(CodexAppServerTaskBackedLiveExecutionPolicyBlocker::TaskCompletionRequested);
    }
    if input.review_acceptance_requested {
        blockers
            .push(CodexAppServerTaskBackedLiveExecutionPolicyBlocker::ReviewAcceptanceRequested);
    }
    if input.scm_mutation_requested {
        blockers.push(CodexAppServerTaskBackedLiveExecutionPolicyBlocker::ScmMutationRequested);
    }
    if input.raw_provider_material_requested {
        blockers
            .push(CodexAppServerTaskBackedLiveExecutionPolicyBlocker::RawProviderMaterialRequested);
    }
}

#[cfg(test)]
mod tests;
