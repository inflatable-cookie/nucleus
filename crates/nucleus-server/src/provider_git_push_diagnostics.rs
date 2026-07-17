//! Read-only diagnostics for Git push admission gates.

use crate::provider_no_effects::{ForgeScmNoEffects};
use serde::{Deserialize, Serialize};

use crate::{
    GitPushAdmissionSet, GitPushAdmissionStatus, GitPushCommandDescriptorSet,
    GitPushCommandDescriptorStatus, GitPushPreflightSet, GitPushPreflightStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitPushDiagnosticsInput {
    pub admissions: GitPushAdmissionSet,
    pub descriptors: GitPushCommandDescriptorSet,
    pub preflights: GitPushPreflightSet,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GitPushDiagnosticsRecord {
    pub diagnostics_id: String,
    pub admission_count: usize,
    pub admission_admitted_count: usize,
    pub descriptor_count: usize,
    pub descriptor_ready_count: usize,
    pub preflight_count: usize,
    pub preflight_ready_count: usize,
    pub remote_target_count: usize,
    pub blocker_count: usize,
    pub shell_handoff_created: bool,
    pub push_executed: bool,
    #[serde(flatten)]
    pub no_effects: ForgeScmNoEffects,
}

pub fn git_push_diagnostics(input: GitPushDiagnosticsInput) -> GitPushDiagnosticsRecord {
    GitPushDiagnosticsRecord {
        diagnostics_id: "git-push-diagnostics".to_owned(),
        admission_count: input.admissions.admissions.len(),
        admission_admitted_count: input
            .admissions
            .admissions
            .iter()
            .filter(|admission| admission.status == GitPushAdmissionStatus::Admitted)
            .count(),
        descriptor_count: input.descriptors.descriptors.len(),
        descriptor_ready_count: input
            .descriptors
            .descriptors
            .iter()
            .filter(|descriptor| descriptor.status == GitPushCommandDescriptorStatus::Ready)
            .count(),
        preflight_count: input.preflights.preflights.len(),
        preflight_ready_count: input
            .preflights
            .preflights
            .iter()
            .filter(|preflight| preflight.status == GitPushPreflightStatus::Ready)
            .count(),
        remote_target_count: input
            .admissions
            .admissions
            .iter()
            .filter(|admission| admission.remote_target.is_some())
            .count(),
        blocker_count: input
            .admissions
            .admissions
            .iter()
            .map(|admission| admission.blockers.len())
            .sum::<usize>()
            + input
                .descriptors
                .descriptors
                .iter()
                .map(|descriptor| descriptor.blockers.len())
                .sum::<usize>()
            + input
                .preflights
                .preflights
                .iter()
                .map(|preflight| preflight.blockers.len())
                .sum::<usize>(),
        shell_handoff_created: false,
        push_executed: false,
        no_effects: ForgeScmNoEffects::none(),
    }
}

#[cfg(test)]
mod tests;
