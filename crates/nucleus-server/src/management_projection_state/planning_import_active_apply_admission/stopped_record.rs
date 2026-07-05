use std::collections::BTreeSet;

use super::super::planning_import_apply_persistence::{
    PlanningProjectionImportStoppedApplyBlocker, PlanningProjectionImportStoppedApplyRecord,
    PlanningProjectionImportStoppedApplyStatus,
};
use super::types::PlanningProjectionImportActiveApplyAdmissionBlocker;

pub(super) fn stopped_apply_record_blockers(
    record: &PlanningProjectionImportStoppedApplyRecord,
    blockers: &mut BTreeSet<PlanningProjectionImportActiveApplyAdmissionBlocker>,
) {
    match record.status {
        PlanningProjectionImportStoppedApplyStatus::Persisted => {}
        PlanningProjectionImportStoppedApplyStatus::DuplicateNoop => {
            blockers.insert(
                PlanningProjectionImportActiveApplyAdmissionBlocker::StoppedApplyDuplicateNoop {
                    stopped_apply_record_id: record.stopped_apply_record_id.clone(),
                },
            );
            blockers.insert(
                PlanningProjectionImportActiveApplyAdmissionBlocker::StoppedApplyNotPersisted {
                    status: "duplicate_noop".to_owned(),
                },
            );
        }
        PlanningProjectionImportStoppedApplyStatus::Blocked => {
            blockers.insert(
                PlanningProjectionImportActiveApplyAdmissionBlocker::StoppedApplyBlocked {
                    stopped_apply_record_id: record.stopped_apply_record_id.clone(),
                },
            );
            blockers.insert(
                PlanningProjectionImportActiveApplyAdmissionBlocker::StoppedApplyNotPersisted {
                    status: "blocked".to_owned(),
                },
            );
        }
    }
    if record.planned_operation_count == 0 {
        blockers
            .insert(PlanningProjectionImportActiveApplyAdmissionBlocker::MissingPlannedOperation);
    }
    if record.blocked_operation_count > 0 {
        blockers
            .insert(PlanningProjectionImportActiveApplyAdmissionBlocker::BlockedOperationPresent);
    }
    for blocker in &record.blockers {
        blockers.insert(
            PlanningProjectionImportActiveApplyAdmissionBlocker::StoppedApplyBlockerPresent {
                blocker: format!("{blocker:?}"),
            },
        );
        stopped_apply_blocker_projection(blocker, blockers);
    }
    if record.raw_payload_retained {
        blockers.insert(PlanningProjectionImportActiveApplyAdmissionBlocker::RawPayloadPresent);
    }
    if record.payload_body_included {
        blockers.insert(PlanningProjectionImportActiveApplyAdmissionBlocker::PayloadBodyIncluded);
    }
    effect_permission_blockers(record, blockers);
}

fn stopped_apply_blocker_projection(
    blocker: &PlanningProjectionImportStoppedApplyBlocker,
    blockers: &mut BTreeSet<PlanningProjectionImportActiveApplyAdmissionBlocker>,
) {
    match blocker {
        PlanningProjectionImportStoppedApplyBlocker::BlockedOperation => {
            blockers.insert(
                PlanningProjectionImportActiveApplyAdmissionBlocker::BlockedOperationPresent,
            );
        }
        PlanningProjectionImportStoppedApplyBlocker::MissingOperationEvidence => {}
        PlanningProjectionImportStoppedApplyBlocker::MissingOperationRecordId => {}
        PlanningProjectionImportStoppedApplyBlocker::UnsupportedOperationKind => {}
        PlanningProjectionImportStoppedApplyBlocker::RawPayloadPresent => {
            blockers.insert(PlanningProjectionImportActiveApplyAdmissionBlocker::RawPayloadPresent);
        }
        PlanningProjectionImportStoppedApplyBlocker::PayloadBodyIncluded => {
            blockers
                .insert(PlanningProjectionImportActiveApplyAdmissionBlocker::PayloadBodyIncluded);
        }
        PlanningProjectionImportStoppedApplyBlocker::ActivePlanningMutationRequested => {
            blockers.insert(
                PlanningProjectionImportActiveApplyAdmissionBlocker::ActivePlanningMutationRequested,
            );
        }
        PlanningProjectionImportStoppedApplyBlocker::TaskCreationRequested => {
            blockers
                .insert(PlanningProjectionImportActiveApplyAdmissionBlocker::TaskCreationRequested);
        }
        PlanningProjectionImportStoppedApplyBlocker::TaskPromotionRequested => {
            blockers.insert(
                PlanningProjectionImportActiveApplyAdmissionBlocker::TaskPromotionRequested,
            );
        }
        PlanningProjectionImportStoppedApplyBlocker::ProjectionWriteRequested => {
            blockers.insert(
                PlanningProjectionImportActiveApplyAdmissionBlocker::ProjectionWriteRequested,
            );
        }
        PlanningProjectionImportStoppedApplyBlocker::AgentSchedulingRequested => {
            blockers.insert(
                PlanningProjectionImportActiveApplyAdmissionBlocker::AgentSchedulingRequested,
            );
        }
        PlanningProjectionImportStoppedApplyBlocker::ProviderExecutionRequested => {
            blockers.insert(
                PlanningProjectionImportActiveApplyAdmissionBlocker::ProviderExecutionRequested,
            );
        }
        PlanningProjectionImportStoppedApplyBlocker::ScmMutationRequested => {
            blockers
                .insert(PlanningProjectionImportActiveApplyAdmissionBlocker::ScmMutationRequested);
        }
        PlanningProjectionImportStoppedApplyBlocker::ForgeMutationRequested => {
            blockers.insert(
                PlanningProjectionImportActiveApplyAdmissionBlocker::ForgeMutationRequested,
            );
        }
        PlanningProjectionImportStoppedApplyBlocker::SemanticMergeRequested => {
            blockers.insert(
                PlanningProjectionImportActiveApplyAdmissionBlocker::SemanticMergeRequested,
            );
        }
        PlanningProjectionImportStoppedApplyBlocker::UiApplyRequested => {
            blockers.insert(PlanningProjectionImportActiveApplyAdmissionBlocker::UiApplyRequested);
        }
        PlanningProjectionImportStoppedApplyBlocker::OperationAuthorityWidened => {
            blockers.insert(
                PlanningProjectionImportActiveApplyAdmissionBlocker::EffectPermissionWidened {
                    effect: "operation_authority".to_owned(),
                },
            );
        }
    };
}

fn effect_permission_blockers(
    record: &PlanningProjectionImportStoppedApplyRecord,
    blockers: &mut BTreeSet<PlanningProjectionImportActiveApplyAdmissionBlocker>,
) {
    let effects = [
        (
            record.active_planning_mutation_permitted,
            "active_planning_mutation",
        ),
        (record.task_creation_permitted, "task_creation"),
        (record.task_promotion_permitted, "task_promotion"),
        (record.projection_write_permitted, "projection_write"),
        (record.agent_scheduling_permitted, "agent_scheduling"),
        (record.provider_execution_permitted, "provider_execution"),
        (record.scm_mutation_permitted, "scm_mutation"),
        (record.forge_mutation_permitted, "forge_mutation"),
        (record.semantic_merge_permitted, "semantic_merge"),
        (record.ui_apply_permitted, "ui_apply"),
    ];
    for (permitted, effect) in effects {
        if permitted {
            blockers.insert(
                PlanningProjectionImportActiveApplyAdmissionBlocker::EffectPermissionWidened {
                    effect: effect.to_owned(),
                },
            );
        }
    }
}
