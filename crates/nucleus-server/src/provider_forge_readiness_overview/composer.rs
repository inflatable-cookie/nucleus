use crate::provider_no_effects::{ProviderNoEffects, ProviderRuntimeNoEffects};
use crate::{
    ForgeNetworkExecutionOperationFamily, ForgePullRequestProvider,
    ForgeReadIntentProjectionFamily, ForgeReadIntentProjectionSet,
};

use super::types::{
    ForgeReadinessOverview, ForgeReadinessOverviewInput, ForgeReadinessOverviewStatus,
};

const SUPPORTED_READ_FAMILIES: [ForgeReadIntentProjectionFamily; 4] = [
    ForgeReadIntentProjectionFamily::CredentialStatus,
    ForgeReadIntentProjectionFamily::RepositoryMetadata,
    ForgeReadIntentProjectionFamily::PullRequest,
    ForgeReadIntentProjectionFamily::StatusCheck,
];

pub fn forge_readiness_overview(input: ForgeReadinessOverviewInput) -> ForgeReadinessOverview {
    let projection = input.projection;
    let represented_read_families = represented_read_families(&projection);
    let represented_mutating_families = represented_mutating_families(&projection);
    let provider_instance_refs = provider_instance_refs(&projection);
    let remote_repo_refs = remote_repo_refs(&projection);
    let forge_providers = forge_providers(&projection);
    let missing_evidence_family_count = SUPPORTED_READ_FAMILIES
        .len()
        .saturating_sub(represented_read_families.len());
    let blocker_count = projection.blocker_count + missing_evidence_family_count;
    let status = overview_status(&projection, missing_evidence_family_count);

    ForgeReadinessOverview {
        overview_id: input.overview_id,
        projection_id: projection.projection_id,
        project_ref: input.project_ref,
        repo_ref: input.repo_ref,
        authority_host_ref: input.authority_host_ref,
        provider_instance_refs,
        remote_repo_refs,
        forge_providers,
        status,
        supported_read_families: SUPPORTED_READ_FAMILIES.to_vec(),
        represented_read_families,
        represented_mutating_families,
        total_read_intent_count: projection.total_count,
        missing_evidence_family_count,
        ready_count: projection.ready_count,
        blocked_count: projection.blocked_count,
        repair_required_count: projection.repair_required_count,
        duplicate_noop_count: projection.duplicate_noop_count,
        blocker_count,
        evidence_ref_count: projection.evidence_ref_count,
        approved_live_read_smoke_evidence_count: input.approved_live_read_smoke_evidence_count,
        no_effects: ProviderRuntimeNoEffects::none(),
    }
}

fn overview_status(
    projection: &ForgeReadIntentProjectionSet,
    missing_evidence_family_count: usize,
) -> ForgeReadinessOverviewStatus {
    if projection.total_count == 0 {
        return ForgeReadinessOverviewStatus::Unknown;
    }

    if projection.blocked_count > 0 || missing_evidence_family_count > 0 {
        return ForgeReadinessOverviewStatus::Blocked;
    }

    if projection.repair_required_count > 0 {
        return ForgeReadinessOverviewStatus::NeedsRepair;
    }

    let represented_ok = projection.ready_count + projection.duplicate_noop_count;
    if represented_ok == projection.total_count {
        return ForgeReadinessOverviewStatus::Ready;
    }

    ForgeReadinessOverviewStatus::Unknown
}

fn represented_read_families(
    projection: &ForgeReadIntentProjectionSet,
) -> Vec<ForgeReadIntentProjectionFamily> {
    let mut families = Vec::new();
    for family in SUPPORTED_READ_FAMILIES {
        if projection
            .entries
            .iter()
            .any(|entry| entry.family == family)
        {
            families.push(family);
        }
    }
    families
}

fn represented_mutating_families(
    projection: &ForgeReadIntentProjectionSet,
) -> Vec<ForgeNetworkExecutionOperationFamily> {
    let mut families = Vec::new();
    for entry in &projection.entries {
        if entry.operation_family.is_mutating() {
            push_unique(&mut families, entry.operation_family.clone());
        }
    }
    families
}

fn provider_instance_refs(projection: &ForgeReadIntentProjectionSet) -> Vec<String> {
    let mut refs = Vec::new();
    for entry in &projection.entries {
        if let Some(provider_instance_ref) = &entry.provider_instance_ref {
            push_unique(&mut refs, provider_instance_ref.clone());
        }
    }
    refs
}

fn remote_repo_refs(projection: &ForgeReadIntentProjectionSet) -> Vec<String> {
    let mut refs = Vec::new();
    for entry in &projection.entries {
        if let Some(remote_repo_ref) = &entry.remote_repo_ref {
            push_unique(&mut refs, remote_repo_ref.clone());
        }
    }
    refs
}

fn forge_providers(projection: &ForgeReadIntentProjectionSet) -> Vec<ForgePullRequestProvider> {
    let mut providers = Vec::new();
    for entry in &projection.entries {
        if let Some(provider) = &entry.forge_provider {
            push_unique(&mut providers, provider.clone());
        }
    }
    providers
}

fn push_unique<T>(values: &mut Vec<T>, value: T)
where
    T: Eq,
{
    if !values.contains(&value) {
        values.push(value);
    }
}
