//! Split from the goal_execution god file; behavior unchanged.

#[allow(unused_imports)]
use super::*;
#[allow(unused_imports)]
use super::{dispatch::*, persistence::*, rules::*, run_loop::*};
#[allow(unused_imports)]
use std::time::{SystemTime, UNIX_EPOCH};

use nucleus_agent_protocol::{AgentSessionId, AgentTurnId};
use nucleus_core::RevisionId;
use nucleus_engine::{
    EngineCheckpointRecordId, EngineDiffSummaryRecordId, EngineRuntimeReceiptEffectFamily,
    EngineRuntimeReceiptRecord, EngineRuntimeReceiptRecordId, EngineRuntimeReceiptRef,
    EngineRuntimeReceiptStatus, EngineTaskAgentWorkUnitReviewStatus,
    EngineTaskAgentWorkUnitRuntimeStatus, EngineTaskAgentWorkUnitSourceId,
};
use nucleus_local_store::{LocalStoreBackend, RevisionExpectation};

use super::super::goal_run::GoalRunPlan;
use super::super::review_evidence::CompletedReviewEvidence;
use super::super::task_execution::{TaskExecutionLinkage, TaskExecutionOutcome};
use crate::runtime_receipt_state::write_runtime_receipt;
use crate::task_agent_work_unit_state::{
    read_task_agent_work_unit_source_records, write_task_agent_work_unit_source_record,
};
use crate::ServerStateService;

pub(super) fn apply_outcome<B>(
    state: &ServerStateService<B>,
    plan: &GoalRunPlan,
    ordinal: usize,
    execution: &mut GoalRunExecutionRecord,
    task_record: &mut GoalTaskExecutionRecord,
    running: Option<&nucleus_engine::EngineTaskAgentWorkUnitSourceRecord>,
    completed_evidence: Option<&CompletedReviewEvidence>,
    outcome: TaskExecutionOutcome,
) -> Result<bool, String>
where
    B: LocalStoreBackend,
{
    let (status, receipt_status, linkage, reason, continue_run) = match outcome {
        TaskExecutionOutcome::Completed(linkage) => (
            "completed",
            EngineRuntimeReceiptStatus::Completed,
            Some(linkage),
            "Provider task turn completed with a reviewable candidate result.".to_owned(),
            true,
        ),
        TaskExecutionOutcome::WaitingForApproval(linkage) => (
            "waiting_for_approval",
            EngineRuntimeReceiptStatus::WaitingForApproval,
            Some(linkage),
            "Provider requested approval; the serial Goal run stopped.".to_owned(),
            false,
        ),
        TaskExecutionOutcome::WaitingForUserInput(linkage) => (
            "waiting_for_user_input",
            EngineRuntimeReceiptStatus::WaitingForUserInput,
            Some(linkage),
            "Provider requested user input; the serial Goal run stopped.".to_owned(),
            false,
        ),
        TaskExecutionOutcome::Cancelled { linkage, reason } => (
            "cancelled",
            EngineRuntimeReceiptStatus::Cancelled,
            linkage,
            reason,
            false,
        ),
        TaskExecutionOutcome::Failed { linkage, reason } => (
            "failed",
            EngineRuntimeReceiptStatus::Failed,
            linkage,
            reason,
            false,
        ),
        TaskExecutionOutcome::RecoveryRequired { linkage, reason } => (
            "recovery_required",
            EngineRuntimeReceiptStatus::RecoveryRequired,
            linkage,
            reason,
            false,
        ),
    };
    let receipt = runtime_receipt(plan, task_record, receipt_status, linkage.as_ref(), &reason);
    write_runtime_receipt(
        state,
        &receipt,
        RevisionId(format!("rev:{}", receipt.receipt_id.0)),
        RevisionExpectation::MustNotExist,
    )
    .map_err(|error| format!("failed to persist Goal task receipt: {error:?}"))?;
    let Some(running) = running else {
        task_record.status = "recovery_required".to_owned();
        task_record.runtime_receipt_id = Some(receipt.receipt_id.0);
        task_record.summary = reason.clone();
        execution.status = GoalRunExecutionStatus::RecoveryRequired;
        execution.terminal_reason = Some(reason);
        return Ok(false);
    };
    let terminal_runtime = match status {
        "completed" => EngineTaskAgentWorkUnitRuntimeStatus::Completed,
        "waiting_for_approval" => EngineTaskAgentWorkUnitRuntimeStatus::WaitingForApproval,
        "waiting_for_user_input" => EngineTaskAgentWorkUnitRuntimeStatus::WaitingForUserInput,
        "cancelled" => EngineTaskAgentWorkUnitRuntimeStatus::Cancelled,
        "failed" => EngineTaskAgentWorkUnitRuntimeStatus::Failed(reason.clone()),
        "recovery_required" => EngineTaskAgentWorkUnitRuntimeStatus::Failed(reason.clone()),
        _ => unreachable!(),
    };
    let review = if status == "completed" {
        EngineTaskAgentWorkUnitReviewStatus::AwaitingReview
    } else {
        EngineTaskAgentWorkUnitReviewStatus::NotReady
    };
    let terminal = transition_source(
        state,
        running,
        ordinal,
        3,
        terminal_runtime,
        review,
        linkage.as_ref(),
        Some(&receipt.receipt_id),
        completed_evidence
            .map(|evidence| std::slice::from_ref(&evidence.target_checkpoint_id))
            .unwrap_or(&[]),
        completed_evidence
            .map(|evidence| std::slice::from_ref(&evidence.diff_summary_id))
            .unwrap_or(&[]),
        &reason,
    )?;
    if status == "recovery_required" {
        transition_source(
            state,
            &terminal,
            ordinal,
            4,
            EngineTaskAgentWorkUnitRuntimeStatus::RecoveryRequired(reason.clone()),
            EngineTaskAgentWorkUnitReviewStatus::NotReady,
            linkage.as_ref(),
            Some(&receipt.receipt_id),
            &[],
            &[],
            &reason,
        )?;
    }
    if matches!(status, "waiting_for_approval" | "waiting_for_user_input") {
        let failed = transition_source(
            state,
            &terminal,
            ordinal,
            4,
            EngineTaskAgentWorkUnitRuntimeStatus::Failed(
                "Interactive provider session could not remain attached.".to_owned(),
            ),
            EngineTaskAgentWorkUnitReviewStatus::NotReady,
            linkage.as_ref(),
            Some(&receipt.receipt_id),
            &[],
            &[],
            "Interactive wait requires recovery.",
        )?;
        transition_source(
            state,
            &failed,
            ordinal,
            5,
            EngineTaskAgentWorkUnitRuntimeStatus::RecoveryRequired(
                "Interactive wait requires a new admitted continuation.".to_owned(),
            ),
            EngineTaskAgentWorkUnitReviewStatus::NotReady,
            linkage.as_ref(),
            Some(&receipt.receipt_id),
            &[],
            &[],
            "Interactive wait requires recovery.",
        )?;
    }
    task_record.status = status.to_owned();
    task_record.runtime_receipt_id = Some(receipt.receipt_id.0);
    task_record.summary = reason.clone();
    if let Some(linkage) = linkage {
        task_record.session_id = Some(linkage.session_id);
        task_record.provider_thread_id = Some(linkage.thread_id);
        task_record.provider_turn_id = Some(linkage.turn_id);
    }
    if !continue_run {
        execution.status = if status == "recovery_required"
            || matches!(status, "waiting_for_approval" | "waiting_for_user_input")
        {
            GoalRunExecutionStatus::RecoveryRequired
        } else if status == "cancelled" {
            GoalRunExecutionStatus::Stopped
        } else {
            GoalRunExecutionStatus::Stopped
        };
        execution.terminal_reason = Some(reason);
    }
    Ok(continue_run)
}

pub(super) fn transition_source<B>(
    state: &ServerStateService<B>,
    previous: &nucleus_engine::EngineTaskAgentWorkUnitSourceRecord,
    ordinal: usize,
    sequence: usize,
    runtime: EngineTaskAgentWorkUnitRuntimeStatus,
    review: EngineTaskAgentWorkUnitReviewStatus,
    linkage: Option<&TaskExecutionLinkage>,
    receipt_id: Option<&EngineRuntimeReceiptRecordId>,
    checkpoint_ids: &[EngineCheckpointRecordId],
    diff_summary_ids: &[EngineDiffSummaryRecordId],
    summary: &str,
) -> Result<nucleus_engine::EngineTaskAgentWorkUnitSourceRecord, String>
where
    B: LocalStoreBackend,
{
    let mut refs = previous.refs.clone();
    if let Some(linkage) = linkage {
        refs.session_id = Some(AgentSessionId(linkage.session_id.clone()));
        if !refs.turn_ids.iter().any(|turn| turn.0 == linkage.turn_id) {
            refs.turn_ids.push(AgentTurnId(linkage.turn_id.clone()));
        }
    }
    if let Some(receipt_id) = receipt_id {
        if !refs.receipt_ids.contains(receipt_id) {
            refs.receipt_ids.push(receipt_id.clone());
        }
    }
    for checkpoint_id in checkpoint_ids {
        if !refs.checkpoint_ids.contains(checkpoint_id) {
            refs.checkpoint_ids.push(checkpoint_id.clone());
        }
    }
    for diff_summary_id in diff_summary_ids {
        if !refs.diff_summary_ids.contains(diff_summary_id) {
            refs.diff_summary_ids.push(diff_summary_id.clone());
        }
    }
    let source_id =
        EngineTaskAgentWorkUnitSourceId(format!("{}:event:{sequence}", previous.work_item_id.0));
    let next = nucleus_engine::EngineTaskAgentWorkUnitSourceRecord {
        source_id: source_id.clone(),
        source_cursor: nucleus_engine::EngineTaskAgentWorkUnitSourceCursor(format!(
            "zz:goal-run:{ordinal:03}:{sequence:03}:{}",
            previous.work_item_id.0
        )),
        runtime,
        review,
        refs,
        previous_source_id: Some(previous.source_id.clone()),
        summary: summary.chars().take(500).collect(),
        ..previous.clone()
    };
    write_task_agent_work_unit_source_record(
        state,
        next.clone(),
        RevisionId(format!("rev:{}", source_id.0)),
        RevisionExpectation::MustNotExist,
    )
    .map_err(|error| format!("failed to persist Goal task transition: {error:?}"))?;
    Ok(next)
}

pub(super) fn latest_source<B>(
    state: &ServerStateService<B>,
    work_item_id: &str,
) -> Result<Option<nucleus_engine::EngineTaskAgentWorkUnitSourceRecord>, String>
where
    B: LocalStoreBackend,
{
    read_task_agent_work_unit_source_records(state)
        .map_err(|error| format!("failed to read Goal task work sources: {error:?}"))
        .map(|records| {
            records
                .into_iter()
                .filter(|source| source.work_item_id.0 == work_item_id)
                .max_by(|left, right| left.source_cursor.0.cmp(&right.source_cursor.0))
        })
}

pub(super) fn runtime_receipt(
    plan: &GoalRunPlan,
    task: &GoalTaskExecutionRecord,
    status: EngineRuntimeReceiptStatus,
    linkage: Option<&TaskExecutionLinkage>,
    summary: &str,
) -> EngineRuntimeReceiptRecord {
    let receipt_id =
        EngineRuntimeReceiptRecordId(format!("receipt:{}:task:{}", plan.plan_id, task.ordinal));
    let mut evidence_refs = vec![
        EngineRuntimeReceiptRef::Custom(plan.mandate_id.clone()),
        EngineRuntimeReceiptRef::Custom(plan.plan_id.clone()),
        EngineRuntimeReceiptRef::Custom(task.dispatch.invocation_request_id.clone()),
    ];
    if let Some(linkage) = linkage {
        evidence_refs.push(EngineRuntimeReceiptRef::Custom(linkage.thread_id.clone()));
        evidence_refs.push(EngineRuntimeReceiptRef::Custom(linkage.turn_id.clone()));
    }
    EngineRuntimeReceiptRecord {
        receipt_id,
        family: EngineRuntimeReceiptEffectFamily::HarnessProvider,
        status,
        command_ref: Some(EngineRuntimeReceiptRef::CommandId(
            task.dispatch.command_id.clone(),
        )),
        effect_ref: linkage.map(|value| {
            EngineRuntimeReceiptRef::Custom(format!("provider-turn:{}", value.turn_id))
        }),
        evidence_refs,
        artifact_refs: Vec::new(),
        summary: Some(summary.chars().take(500).collect()),
    }
}
