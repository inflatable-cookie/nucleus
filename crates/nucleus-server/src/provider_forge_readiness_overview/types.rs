use serde::{Deserialize, Serialize};

use crate::{
    ForgeNetworkExecutionOperationFamily, ForgePullRequestProvider,
    ForgeReadIntentProjectionFamily, ForgeReadIntentProjectionSet,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ForgeReadinessOverviewInput {
    pub overview_id: String,
    pub project_ref: Option<String>,
    pub repo_ref: Option<String>,
    pub authority_host_ref: Option<String>,
    pub projection: ForgeReadIntentProjectionSet,
    pub approved_live_read_smoke_evidence_count: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ForgeReadinessOverview {
    pub overview_id: String,
    pub projection_id: String,
    pub project_ref: Option<String>,
    pub repo_ref: Option<String>,
    pub authority_host_ref: Option<String>,
    pub provider_instance_refs: Vec<String>,
    pub remote_repo_refs: Vec<String>,
    pub forge_providers: Vec<ForgePullRequestProvider>,
    pub status: ForgeReadinessOverviewStatus,
    pub supported_read_families: Vec<ForgeReadIntentProjectionFamily>,
    pub represented_read_families: Vec<ForgeReadIntentProjectionFamily>,
    pub represented_mutating_families: Vec<ForgeNetworkExecutionOperationFamily>,
    pub total_read_intent_count: usize,
    pub missing_evidence_family_count: usize,
    pub ready_count: usize,
    pub blocked_count: usize,
    pub repair_required_count: usize,
    pub duplicate_noop_count: usize,
    pub blocker_count: usize,
    pub evidence_ref_count: usize,
    pub approved_live_read_smoke_evidence_count: usize,
    pub credential_resolution_performed: bool,
    pub provider_network_call_performed: bool,
    pub provider_effect_executed: bool,
    pub callback_effect_executed: bool,
    pub interruption_effect_executed: bool,
    pub recovery_effect_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_provider_payload_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ForgeReadinessOverviewStatus {
    Ready,
    Blocked,
    NeedsRepair,
    Unknown,
    Unsupported,
}
