//! Diagnostics for SCM change-request adapter plan selection.

use serde::{Deserialize, Serialize};

use crate::{
    ScmChangeRequestAdapterPlanKind, ScmChangeRequestAdapterPlanRecordsRecord,
    ScmChangeRequestAdapterPlanStatus,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ScmChangeRequestAdapterPlanDiagnosticsRecord {
    pub diagnostics_id: String,
    pub plan_count: usize,
    pub ready_count: usize,
    pub blocked_count: usize,
    pub repair_required_count: usize,
    pub unsupported_count: usize,
    pub git_like_count: usize,
    pub convergence_like_count: usize,
    pub unsupported_adapter_count: usize,
    pub blocker_count: usize,
    pub branch_or_snapshot_authority_granted: bool,
    pub commit_or_publish_authority_granted: bool,
    pub push_or_remote_publish_authority_granted: bool,
    pub forge_authority_granted: bool,
    pub provider_authority_granted: bool,
    pub callback_authority_granted: bool,
    pub interruption_authority_granted: bool,
    pub recovery_authority_granted: bool,
    pub raw_output_retained: bool,
}

pub fn scm_change_request_adapter_plan_diagnostics(
    records: ScmChangeRequestAdapterPlanRecordsRecord,
) -> ScmChangeRequestAdapterPlanDiagnosticsRecord {
    ScmChangeRequestAdapterPlanDiagnosticsRecord {
        diagnostics_id: "scm-change-request-adapter-plan-diagnostics".to_owned(),
        plan_count: records.plans.len(),
        ready_count: status_count(&records, ScmChangeRequestAdapterPlanStatus::Ready),
        blocked_count: status_count(&records, ScmChangeRequestAdapterPlanStatus::Blocked),
        repair_required_count: status_count(
            &records,
            ScmChangeRequestAdapterPlanStatus::RepairRequired,
        ),
        unsupported_count: status_count(&records, ScmChangeRequestAdapterPlanStatus::Unsupported),
        git_like_count: kind_count(
            &records,
            ScmChangeRequestAdapterPlanKind::GitBranchChangeRequest,
        ),
        convergence_like_count: kind_count(
            &records,
            ScmChangeRequestAdapterPlanKind::SnapshotPublishChangeRequest,
        ),
        unsupported_adapter_count: kind_count(
            &records,
            ScmChangeRequestAdapterPlanKind::UnsupportedAdapter,
        ),
        blocker_count: records.plans.iter().map(|plan| plan.blockers.len()).sum(),
        branch_or_snapshot_authority_granted: false,
        commit_or_publish_authority_granted: false,
        push_or_remote_publish_authority_granted: false,
        forge_authority_granted: false,
        provider_authority_granted: false,
        callback_authority_granted: false,
        interruption_authority_granted: false,
        recovery_authority_granted: false,
        raw_output_retained: false,
    }
}

fn status_count(
    records: &ScmChangeRequestAdapterPlanRecordsRecord,
    status: ScmChangeRequestAdapterPlanStatus,
) -> usize {
    records
        .plans
        .iter()
        .filter(|plan| plan.status == status)
        .count()
}

fn kind_count(
    records: &ScmChangeRequestAdapterPlanRecordsRecord,
    kind: ScmChangeRequestAdapterPlanKind,
) -> usize {
    records
        .plans
        .iter()
        .filter(|plan| plan.plan_kind == kind)
        .count()
}

#[cfg(test)]
mod tests;
