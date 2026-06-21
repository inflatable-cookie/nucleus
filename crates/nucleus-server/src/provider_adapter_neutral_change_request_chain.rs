//! Adapter-neutral change-request chain projection records.

use serde::{Deserialize, Serialize};

use crate::{
    ScmChangeRequestAdapterPlanKind, ScmChangeRequestAdapterPlanRecord,
    ScmChangeRequestAdapterPlanRecordsRecord, ScmChangeRequestAdapterPlanStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdapterNeutralChangeRequestChainInput {
    pub adapter_plans: ScmChangeRequestAdapterPlanRecordsRecord,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct AdapterNeutralChangeRequestChainProjection {
    pub projection_id: String,
    pub stages: Vec<AdapterNeutralChangeRequestChainStage>,
    pub skipped_adapter_plan_ids: Vec<String>,
    pub branch_or_snapshot_authority_granted: bool,
    pub local_revision_authority_granted: bool,
    pub remote_share_authority_granted: bool,
    pub review_request_authority_granted: bool,
    pub provider_authority_granted: bool,
    pub callback_authority_granted: bool,
    pub interruption_authority_granted: bool,
    pub recovery_authority_granted: bool,
    pub task_mutation_executed: bool,
    pub raw_output_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct AdapterNeutralChangeRequestChainStage {
    pub stage_id: String,
    pub adapter_plan_id: String,
    pub persisted_preparation_id: String,
    pub admission_id: String,
    pub workflow_id: String,
    pub task_id: String,
    pub work_item_id: Option<String>,
    pub completion_id: Option<String>,
    pub repo_id: String,
    pub operator_ref: String,
    pub adapter_label: String,
    pub workflow_label: String,
    pub evidence_refs: Vec<String>,
    pub neutral_stage: AdapterNeutralChangeRequestStageKind,
    pub provider_ref: AdapterNeutralChangeRequestProviderStageRef,
    pub status: AdapterNeutralChangeRequestChainStageStatus,
    pub blockers: Vec<AdapterNeutralChangeRequestChainBlocker>,
    pub effect_executed: bool,
    pub provider_effect_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_output_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AdapterNeutralChangeRequestStageKind {
    IsolatedWorkArea,
    LocalRevision,
    RemoteShare,
    ReviewRequest,
    Unsupported,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AdapterNeutralChangeRequestProviderStageRef {
    GitLike {
        stage_kind: GitLikeChangeRequestProviderStageKind,
        provider_record_ref: String,
    },
    ConvergenceLike {
        stage_kind: ConvergenceLikeChangeRequestProviderStageKind,
        provider_record_ref: String,
    },
    Unsupported {
        adapter_label: String,
        provider_record_ref: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitLikeChangeRequestProviderStageKind {
    BranchOrWorktree,
    Commit,
    Push,
    PullRequest,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConvergenceLikeChangeRequestProviderStageKind {
    Snapshot,
    Publish,
    PublicationReview,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AdapterNeutralChangeRequestChainStageStatus {
    Ready,
    Blocked,
    Unsupported,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AdapterNeutralChangeRequestChainBlocker {
    AdapterPlanNotReady,
    UnsupportedAdapter,
}

pub fn adapter_neutral_change_request_chain_projection(
    input: AdapterNeutralChangeRequestChainInput,
) -> AdapterNeutralChangeRequestChainProjection {
    let mut stages = input
        .adapter_plans
        .plans
        .into_iter()
        .flat_map(stages_for_plan)
        .collect::<Vec<_>>();
    stages.sort_by(|left, right| left.stage_id.cmp(&right.stage_id));

    AdapterNeutralChangeRequestChainProjection {
        projection_id: "adapter-neutral-change-request-chain".to_owned(),
        skipped_adapter_plan_ids: skipped_adapter_plan_ids(&stages),
        stages,
        branch_or_snapshot_authority_granted: false,
        local_revision_authority_granted: false,
        remote_share_authority_granted: false,
        review_request_authority_granted: false,
        provider_authority_granted: false,
        callback_authority_granted: false,
        interruption_authority_granted: false,
        recovery_authority_granted: false,
        task_mutation_executed: false,
        raw_output_retained: false,
    }
}

fn stages_for_plan(
    plan: ScmChangeRequestAdapterPlanRecord,
) -> Vec<AdapterNeutralChangeRequestChainStage> {
    let stage_specs = stage_specs_for_kind(&plan);
    stage_specs
        .into_iter()
        .map(|spec| stage_from_spec(&plan, spec))
        .collect()
}

fn stage_from_spec(
    plan: &ScmChangeRequestAdapterPlanRecord,
    spec: StageSpec,
) -> AdapterNeutralChangeRequestChainStage {
    let blockers = blockers(plan);
    let status = status(plan, &blockers);

    AdapterNeutralChangeRequestChainStage {
        stage_id: format!(
            "adapter-neutral-change-request-chain:{}:{}",
            plan.adapter_plan_id, spec.stage_ref_suffix
        ),
        adapter_plan_id: plan.adapter_plan_id.clone(),
        persisted_preparation_id: plan.persisted_preparation_id.clone(),
        admission_id: plan.admission_id.clone(),
        workflow_id: plan.workflow_id.clone(),
        task_id: plan.task_id.clone(),
        work_item_id: plan.work_item_id.clone(),
        completion_id: plan.completion_id.clone(),
        repo_id: plan.repo_id.clone(),
        operator_ref: plan.operator_ref.clone(),
        adapter_label: plan.adapter_label.clone(),
        workflow_label: plan.workflow_label.clone(),
        evidence_refs: plan.evidence_refs.clone(),
        neutral_stage: spec.neutral_stage,
        provider_ref: spec.provider_ref,
        status,
        blockers,
        effect_executed: false,
        provider_effect_executed: false,
        task_mutation_executed: false,
        raw_output_retained: false,
    }
}

fn stage_specs_for_kind(plan: &ScmChangeRequestAdapterPlanRecord) -> Vec<StageSpec> {
    match plan.plan_kind {
        ScmChangeRequestAdapterPlanKind::GitBranchChangeRequest => git_like_specs(plan),
        ScmChangeRequestAdapterPlanKind::SnapshotPublishChangeRequest => {
            convergence_like_specs(plan)
        }
        ScmChangeRequestAdapterPlanKind::UnsupportedAdapter => vec![StageSpec {
            stage_ref_suffix: "unsupported".to_owned(),
            neutral_stage: AdapterNeutralChangeRequestStageKind::Unsupported,
            provider_ref: AdapterNeutralChangeRequestProviderStageRef::Unsupported {
                adapter_label: plan.adapter_label.clone(),
                provider_record_ref: format!(
                    "unsupported-change-request-adapter:{}",
                    plan.persisted_preparation_id
                ),
            },
        }],
    }
}

fn git_like_specs(plan: &ScmChangeRequestAdapterPlanRecord) -> Vec<StageSpec> {
    vec![
        git_like_spec(
            "isolated-work-area",
            AdapterNeutralChangeRequestStageKind::IsolatedWorkArea,
            GitLikeChangeRequestProviderStageKind::BranchOrWorktree,
            format!("git-branch-worktree:{}", plan.persisted_preparation_id),
        ),
        git_like_spec(
            "local-revision",
            AdapterNeutralChangeRequestStageKind::LocalRevision,
            GitLikeChangeRequestProviderStageKind::Commit,
            format!("git-commit:{}", plan.persisted_preparation_id),
        ),
        git_like_spec(
            "remote-share",
            AdapterNeutralChangeRequestStageKind::RemoteShare,
            GitLikeChangeRequestProviderStageKind::Push,
            format!("git-push:{}", plan.persisted_preparation_id),
        ),
        git_like_spec(
            "review-request",
            AdapterNeutralChangeRequestStageKind::ReviewRequest,
            GitLikeChangeRequestProviderStageKind::PullRequest,
            format!("forge-pull-request:{}", plan.persisted_preparation_id),
        ),
    ]
}

fn convergence_like_specs(plan: &ScmChangeRequestAdapterPlanRecord) -> Vec<StageSpec> {
    vec![
        convergence_like_spec(
            "local-revision",
            AdapterNeutralChangeRequestStageKind::LocalRevision,
            ConvergenceLikeChangeRequestProviderStageKind::Snapshot,
            format!("convergence-snapshot:{}", plan.persisted_preparation_id),
        ),
        convergence_like_spec(
            "remote-share",
            AdapterNeutralChangeRequestStageKind::RemoteShare,
            ConvergenceLikeChangeRequestProviderStageKind::Publish,
            format!("convergence-publish:{}", plan.persisted_preparation_id),
        ),
        convergence_like_spec(
            "review-request",
            AdapterNeutralChangeRequestStageKind::ReviewRequest,
            ConvergenceLikeChangeRequestProviderStageKind::PublicationReview,
            format!(
                "convergence-publication-review:{}",
                plan.persisted_preparation_id
            ),
        ),
    ]
}

fn git_like_spec(
    stage_ref_suffix: &str,
    neutral_stage: AdapterNeutralChangeRequestStageKind,
    stage_kind: GitLikeChangeRequestProviderStageKind,
    provider_record_ref: String,
) -> StageSpec {
    StageSpec {
        stage_ref_suffix: stage_ref_suffix.to_owned(),
        neutral_stage,
        provider_ref: AdapterNeutralChangeRequestProviderStageRef::GitLike {
            stage_kind,
            provider_record_ref,
        },
    }
}

fn convergence_like_spec(
    stage_ref_suffix: &str,
    neutral_stage: AdapterNeutralChangeRequestStageKind,
    stage_kind: ConvergenceLikeChangeRequestProviderStageKind,
    provider_record_ref: String,
) -> StageSpec {
    StageSpec {
        stage_ref_suffix: stage_ref_suffix.to_owned(),
        neutral_stage,
        provider_ref: AdapterNeutralChangeRequestProviderStageRef::ConvergenceLike {
            stage_kind,
            provider_record_ref,
        },
    }
}

fn blockers(
    plan: &ScmChangeRequestAdapterPlanRecord,
) -> Vec<AdapterNeutralChangeRequestChainBlocker> {
    let mut blockers = Vec::new();
    if plan.status != ScmChangeRequestAdapterPlanStatus::Ready {
        blockers.push(AdapterNeutralChangeRequestChainBlocker::AdapterPlanNotReady);
    }
    if plan.plan_kind == ScmChangeRequestAdapterPlanKind::UnsupportedAdapter {
        blockers.push(AdapterNeutralChangeRequestChainBlocker::UnsupportedAdapter);
    }
    blockers
}

fn status(
    plan: &ScmChangeRequestAdapterPlanRecord,
    blockers: &[AdapterNeutralChangeRequestChainBlocker],
) -> AdapterNeutralChangeRequestChainStageStatus {
    if plan.plan_kind == ScmChangeRequestAdapterPlanKind::UnsupportedAdapter {
        AdapterNeutralChangeRequestChainStageStatus::Unsupported
    } else if blockers.is_empty() {
        AdapterNeutralChangeRequestChainStageStatus::Ready
    } else {
        AdapterNeutralChangeRequestChainStageStatus::Blocked
    }
}

fn skipped_adapter_plan_ids(stages: &[AdapterNeutralChangeRequestChainStage]) -> Vec<String> {
    let mut ids = stages
        .iter()
        .filter(|stage| stage.status != AdapterNeutralChangeRequestChainStageStatus::Ready)
        .map(|stage| stage.adapter_plan_id.clone())
        .collect::<Vec<_>>();
    ids.sort();
    ids.dedup();
    ids
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct StageSpec {
    stage_ref_suffix: String,
    neutral_stage: AdapterNeutralChangeRequestStageKind,
    provider_ref: AdapterNeutralChangeRequestProviderStageRef,
}

#[cfg(test)]
#[path = "provider_adapter_neutral_change_request_chain/tests.rs"]
mod tests;
