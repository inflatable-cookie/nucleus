use std::collections::BTreeSet;

use super::types::{
    PlanningProjectionImportActiveApplyAdmissionBlocker,
    PlanningProjectionImportActiveApplyAdmissionRequest,
};

pub(super) fn requested_effect_blockers(
    request: &PlanningProjectionImportActiveApplyAdmissionRequest,
    blockers: &mut BTreeSet<PlanningProjectionImportActiveApplyAdmissionBlocker>,
) {
    if request.active_planning_mutation_requested {
        blockers.insert(
            PlanningProjectionImportActiveApplyAdmissionBlocker::ActivePlanningMutationRequested,
        );
    }
    if request.executor_invocation_requested {
        blockers.insert(
            PlanningProjectionImportActiveApplyAdmissionBlocker::ExecutorInvocationRequested,
        );
    }
    if request.task_creation_requested {
        blockers.insert(PlanningProjectionImportActiveApplyAdmissionBlocker::TaskCreationRequested);
    }
    if request.task_promotion_requested {
        blockers
            .insert(PlanningProjectionImportActiveApplyAdmissionBlocker::TaskPromotionRequested);
    }
    if request.projection_write_requested {
        blockers
            .insert(PlanningProjectionImportActiveApplyAdmissionBlocker::ProjectionWriteRequested);
    }
    if request.agent_scheduling_requested {
        blockers
            .insert(PlanningProjectionImportActiveApplyAdmissionBlocker::AgentSchedulingRequested);
    }
    if request.provider_execution_requested {
        blockers.insert(
            PlanningProjectionImportActiveApplyAdmissionBlocker::ProviderExecutionRequested,
        );
    }
    if request.scm_mutation_requested {
        blockers.insert(PlanningProjectionImportActiveApplyAdmissionBlocker::ScmMutationRequested);
    }
    if request.forge_mutation_requested {
        blockers
            .insert(PlanningProjectionImportActiveApplyAdmissionBlocker::ForgeMutationRequested);
    }
    if request.semantic_merge_requested {
        blockers
            .insert(PlanningProjectionImportActiveApplyAdmissionBlocker::SemanticMergeRequested);
    }
    if request.accepted_memory_mutation_requested {
        blockers.insert(
            PlanningProjectionImportActiveApplyAdmissionBlocker::AcceptedMemoryMutationRequested,
        );
    }
    if request.callback_requested {
        blockers.insert(PlanningProjectionImportActiveApplyAdmissionBlocker::CallbackRequested);
    }
    if request.interruption_requested {
        blockers.insert(PlanningProjectionImportActiveApplyAdmissionBlocker::InterruptionRequested);
    }
    if request.recovery_requested {
        blockers.insert(PlanningProjectionImportActiveApplyAdmissionBlocker::RecoveryRequested);
    }
    if request.ui_apply_requested {
        blockers.insert(PlanningProjectionImportActiveApplyAdmissionBlocker::UiApplyRequested);
    }
}
