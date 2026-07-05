use std::collections::BTreeSet;

use super::types::{
    PlanningProjectionImportActiveApplyExecutorBlocker,
    PlanningProjectionImportActiveApplyExecutorRequest,
};

pub(super) fn requested_effect_blockers(
    request: &PlanningProjectionImportActiveApplyExecutorRequest,
    blockers: &mut BTreeSet<PlanningProjectionImportActiveApplyExecutorBlocker>,
) {
    if request.active_planning_mutation_requested {
        blockers.insert(
            PlanningProjectionImportActiveApplyExecutorBlocker::ActivePlanningMutationRequested,
        );
    }
    if request.final_mutation_receipt_requested {
        blockers.insert(
            PlanningProjectionImportActiveApplyExecutorBlocker::FinalMutationReceiptRequested,
        );
    }
    if request.task_creation_requested {
        blockers.insert(PlanningProjectionImportActiveApplyExecutorBlocker::TaskCreationRequested);
    }
    if request.task_promotion_requested {
        blockers.insert(PlanningProjectionImportActiveApplyExecutorBlocker::TaskPromotionRequested);
    }
    if request.projection_write_requested {
        blockers
            .insert(PlanningProjectionImportActiveApplyExecutorBlocker::ProjectionWriteRequested);
    }
    if request.agent_scheduling_requested {
        blockers
            .insert(PlanningProjectionImportActiveApplyExecutorBlocker::AgentSchedulingRequested);
    }
    if request.provider_execution_requested {
        blockers
            .insert(PlanningProjectionImportActiveApplyExecutorBlocker::ProviderExecutionRequested);
    }
    if request.scm_mutation_requested {
        blockers.insert(PlanningProjectionImportActiveApplyExecutorBlocker::ScmMutationRequested);
    }
    if request.forge_mutation_requested {
        blockers.insert(PlanningProjectionImportActiveApplyExecutorBlocker::ForgeMutationRequested);
    }
    if request.semantic_merge_requested {
        blockers.insert(PlanningProjectionImportActiveApplyExecutorBlocker::SemanticMergeRequested);
    }
    if request.accepted_memory_mutation_requested {
        blockers.insert(
            PlanningProjectionImportActiveApplyExecutorBlocker::AcceptedMemoryMutationRequested,
        );
    }
    if request.callback_requested {
        blockers.insert(PlanningProjectionImportActiveApplyExecutorBlocker::CallbackRequested);
    }
    if request.interruption_requested {
        blockers.insert(PlanningProjectionImportActiveApplyExecutorBlocker::InterruptionRequested);
    }
    if request.recovery_requested {
        blockers.insert(PlanningProjectionImportActiveApplyExecutorBlocker::RecoveryRequested);
    }
    if request.ui_apply_requested {
        blockers.insert(PlanningProjectionImportActiveApplyExecutorBlocker::UiApplyRequested);
    }
}
