//! Stopped active-apply admissions for accepted-memory review receipts.
//!
//! This module grants no mutation authority. It only records whether a durable
//! approved review receipt is eligible for a later active accepted-memory apply
//! executor.

mod blockers;
mod counts;
mod record_builder;
mod refs;
mod types;

pub use refs::accepted_memory_active_apply_admission_ref;
pub use types::*;

use counts::active_apply_admission_counts;
use record_builder::active_apply_admission_record;

pub fn accepted_memory_active_apply_admissions(
    inputs: impl IntoIterator<Item = AcceptedMemoryActiveApplyAdmissionInput>,
) -> AcceptedMemoryActiveApplyAdmissionSet {
    let records: Vec<_> = inputs
        .into_iter()
        .map(active_apply_admission_record)
        .collect();
    let counts = active_apply_admission_counts(&records);

    AcceptedMemoryActiveApplyAdmissionSet {
        records,
        counts,
        active_memory_apply_performed: false,
        projection_write_performed: false,
        scm_effect_performed: false,
        embedding_available: false,
        provider_sync_available: false,
        automatic_extraction_performed: false,
        task_mutation_performed: false,
        agent_scheduling_performed: false,
        ui_effect_performed: false,
    }
}
