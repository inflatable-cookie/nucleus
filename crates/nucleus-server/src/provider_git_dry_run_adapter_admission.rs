//! Git adapter admission records for SCM capture dry-run descriptors.

use serde::{Deserialize, Serialize};

use crate::{
    GitDryRunCommandDescriptorSet, ScmCaptureDryRunExecutionCapabilityRecord,
    ScmCaptureDryRunExecutionCapabilityStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitDryRunAdapterAdmissionInput {
    pub capability: ScmCaptureDryRunExecutionCapabilityRecord,
    pub descriptors: GitDryRunCommandDescriptorSet,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitDryRunAdapterAdmissionSet {
    pub admission_set_id: String,
    pub admissions: Vec<GitDryRunAdapterAdmissionRecord>,
    pub skipped_capability_item_ids: Vec<String>,
    pub git_mutation_authority_granted: bool,
    pub forge_authority_granted: bool,
    pub provider_authority_granted: bool,
    pub raw_output_retention_granted: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitDryRunAdapterAdmissionRecord {
    pub admission_id: String,
    pub capability_item_id: String,
    pub persisted_dry_run_plan_id: String,
    pub task_id: String,
    pub work_item_id: Option<String>,
    pub completion_id: Option<String>,
    pub operator_ref: String,
    pub evidence_refs: Vec<String>,
    pub descriptor_ids: Vec<String>,
    pub status: GitDryRunAdapterAdmissionStatus,
    pub blockers: Vec<GitDryRunAdapterAdmissionBlocker>,
    pub git_dry_run_admitted: bool,
    pub git_mutation_authority_granted: bool,
    pub forge_authority_granted: bool,
    pub provider_authority_granted: bool,
    pub raw_output_retention_granted: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitDryRunAdapterAdmissionStatus {
    Admitted,
    Unsupported,
    RepairRequired,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitDryRunAdapterAdmissionBlocker {
    CapabilityNotReady,
    AdapterNotGit,
    DescriptorSetEmpty,
    RawOutputRetentionRequested,
}

pub fn git_dry_run_adapter_admission(
    input: GitDryRunAdapterAdmissionInput,
) -> GitDryRunAdapterAdmissionSet {
    let descriptor_ids = input
        .descriptors
        .descriptors
        .iter()
        .map(|descriptor| descriptor.descriptor_id.clone())
        .collect::<Vec<_>>();
    let mut admissions = Vec::new();
    let mut skipped_capability_item_ids = Vec::new();

    for item in input.capability.items {
        let blockers = blockers(&item, &input.descriptors);
        if !blockers.is_empty() {
            skipped_capability_item_ids.push(item.capability_item_id.clone());
        }
        let status = status(&blockers);
        let git_dry_run_admitted = status == GitDryRunAdapterAdmissionStatus::Admitted;
        admissions.push(GitDryRunAdapterAdmissionRecord {
            admission_id: format!("git-dry-run-admission:{}", item.capability_item_id),
            capability_item_id: item.capability_item_id,
            persisted_dry_run_plan_id: item.persisted_dry_run_plan_id,
            task_id: item.task_id,
            work_item_id: item.work_item_id,
            completion_id: item.completion_id,
            operator_ref: item.operator_ref,
            evidence_refs: item.evidence_refs,
            descriptor_ids: descriptor_ids.clone(),
            status,
            blockers,
            git_dry_run_admitted,
            git_mutation_authority_granted: false,
            forge_authority_granted: false,
            provider_authority_granted: false,
            raw_output_retention_granted: false,
        });
    }

    GitDryRunAdapterAdmissionSet {
        admission_set_id: "git-dry-run-admissions".to_owned(),
        admissions,
        skipped_capability_item_ids,
        git_mutation_authority_granted: false,
        forge_authority_granted: false,
        provider_authority_granted: false,
        raw_output_retention_granted: false,
    }
}

fn blockers(
    item: &crate::ScmCaptureDryRunExecutionCapabilityItem,
    descriptors: &GitDryRunCommandDescriptorSet,
) -> Vec<GitDryRunAdapterAdmissionBlocker> {
    let mut blockers = Vec::new();
    if item.status != ScmCaptureDryRunExecutionCapabilityStatus::Ready {
        blockers.push(GitDryRunAdapterAdmissionBlocker::CapabilityNotReady);
    }
    if item.adapter_label != "git" {
        blockers.push(GitDryRunAdapterAdmissionBlocker::AdapterNotGit);
    }
    if descriptors.descriptors.is_empty() {
        blockers.push(GitDryRunAdapterAdmissionBlocker::DescriptorSetEmpty);
    }
    if descriptors.raw_output_retention_granted {
        blockers.push(GitDryRunAdapterAdmissionBlocker::RawOutputRetentionRequested);
    }
    blockers
}

fn status(blockers: &[GitDryRunAdapterAdmissionBlocker]) -> GitDryRunAdapterAdmissionStatus {
    if blockers.is_empty() {
        GitDryRunAdapterAdmissionStatus::Admitted
    } else if blockers
        .iter()
        .any(|blocker| blocker == &GitDryRunAdapterAdmissionBlocker::CapabilityNotReady)
    {
        GitDryRunAdapterAdmissionStatus::RepairRequired
    } else {
        GitDryRunAdapterAdmissionStatus::Unsupported
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_dry_run_adapter_admission_maps_ready_git_capability() {
        let set = git_dry_run_adapter_admission(input("git", true));

        assert_eq!(set.admissions.len(), 1);
        assert_eq!(
            set.admissions[0].status,
            GitDryRunAdapterAdmissionStatus::Admitted
        );
        assert_eq!(set.admissions[0].descriptor_ids.len(), 2);
        assert!(set.admissions[0].git_dry_run_admitted);
        assert!(!set.git_mutation_authority_granted);
        assert!(!set.raw_output_retention_granted);
    }

    #[test]
    fn git_dry_run_adapter_admission_rejects_non_git_adapter() {
        let set = git_dry_run_adapter_admission(input("convergence", true));

        assert_eq!(
            set.admissions[0].status,
            GitDryRunAdapterAdmissionStatus::Unsupported
        );
        assert!(set.admissions[0]
            .blockers
            .contains(&GitDryRunAdapterAdmissionBlocker::AdapterNotGit));
        assert!(!set.admissions[0].git_dry_run_admitted);
    }

    fn input(adapter_label: &str, ready: bool) -> GitDryRunAdapterAdmissionInput {
        GitDryRunAdapterAdmissionInput {
            capability: crate::ScmCaptureDryRunExecutionCapabilityRecord {
                capability_id: "capability".to_owned(),
                items: vec![crate::ScmCaptureDryRunExecutionCapabilityItem {
                    capability_item_id: "capability:1".to_owned(),
                    admission_id: "admission:1".to_owned(),
                    persisted_dry_run_plan_id: "persisted:1".to_owned(),
                    dry_run_plan_item_id: "dry-run-plan:1".to_owned(),
                    task_id: "task:1".to_owned(),
                    work_item_id: Some("work:1".to_owned()),
                    completion_id: Some("completion:1".to_owned()),
                    operator_ref: "operator:tom".to_owned(),
                    evidence_refs: vec!["evidence:capability".to_owned()],
                    adapter_label: adapter_label.to_owned(),
                    workflow_label: "working-tree-preview".to_owned(),
                    status: if ready {
                        ScmCaptureDryRunExecutionCapabilityStatus::Ready
                    } else {
                        ScmCaptureDryRunExecutionCapabilityStatus::RepairRequired
                    },
                    blockers: Vec::new(),
                }],
                skipped_dry_run_plan_ids: Vec::new(),
                adapter_label: adapter_label.to_owned(),
                workflow_label: "working-tree-preview".to_owned(),
                scm_dry_run_executed: false,
                scm_capture_executed: false,
                scm_publish_executed: false,
                forge_authority_granted: false,
                provider_authority_granted: false,
                raw_material_exposed: false,
            },
            descriptors: crate::git_dry_run_command_descriptors(),
        }
    }
}
