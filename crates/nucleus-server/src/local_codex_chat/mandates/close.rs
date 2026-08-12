//! Workflow mandate closure: cancel, revoke, and expire transitions with
//! revision-conflict-safe terminal writes.
//!
//! Split from the mandates god file; behavior unchanged.

use nucleus_core::RevisionId;
use nucleus_local_store::{LocalStoreBackend, RevisionExpectation};

use super::store::{put_mandate, read_workflow_mandate, require_nonempty};
use super::types::{WorkflowMandate, WorkflowMandateStatus};
use crate::ServerStateService;

pub fn cancel_workflow_mandate<B>(
    state: &ServerStateService<B>,
    mandate_id: &str,
    expected_revision: &str,
    reason: &str,
) -> Result<WorkflowMandate, String>
where
    B: LocalStoreBackend,
{
    close_mandate(
        state,
        mandate_id,
        expected_revision,
        reason,
        WorkflowMandateStatus::Cancelled,
        "cancelled",
        Vec::new(),
    )
}

pub fn revoke_workflow_mandate<B>(
    state: &ServerStateService<B>,
    mandate_id: &str,
    expected_revision: &str,
    reason: &str,
) -> Result<WorkflowMandate, String>
where
    B: LocalStoreBackend,
{
    close_mandate(
        state,
        mandate_id,
        expected_revision,
        reason,
        WorkflowMandateStatus::Revoked,
        "revoked",
        Vec::new(),
    )
}

pub(crate) fn expire_workflow_mandate<B>(
    state: &ServerStateService<B>,
    mandate_id: &str,
    expected_revision: &str,
    reason: &str,
    outcome_refs: Vec<String>,
) -> Result<WorkflowMandate, String>
where
    B: LocalStoreBackend,
{
    close_mandate(
        state,
        mandate_id,
        expected_revision,
        reason,
        WorkflowMandateStatus::Expired,
        "expired",
        outcome_refs,
    )
}

fn close_mandate<B>(
    state: &ServerStateService<B>,
    mandate_id: &str,
    expected_revision: &str,
    reason: &str,
    status: WorkflowMandateStatus,
    suffix: &str,
    outcome_refs: Vec<String>,
) -> Result<WorkflowMandate, String>
where
    B: LocalStoreBackend,
{
    require_nonempty("terminal reason", reason.trim())?;
    let mut mandate = read_workflow_mandate(state, mandate_id)?;
    if mandate.revision_id != expected_revision {
        return Err("goal mandate revision conflict".to_owned());
    }
    if mandate.status != WorkflowMandateStatus::Active {
        return Err("only an active workflow mandate can be closed".to_owned());
    }
    mandate.status = status;
    mandate.terminal_reason = Some(reason.trim().to_owned());
    mandate.outcome_refs = outcome_refs;
    let previous_revision = RevisionId(mandate.revision_id.clone());
    mandate.revision_id = format!("rev:{mandate_id}:{suffix}");
    put_mandate(
        state,
        &mandate,
        RevisionExpectation::Exact(previous_revision),
    )?;
    Ok(mandate)
}
