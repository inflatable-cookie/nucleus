//! Stopped apply/admission records for accepted-memory projection imports.
//!
//! This module grants no mutation authority. It only records whether a
//! validated projected-memory import is eligible for a later active apply
//! executor.

mod blockers;
mod counts;
mod record_builder;
mod refs;
mod types;

pub use refs::accepted_memory_projection_import_apply_admission_ref;
pub use types::*;

use crate::provider_no_effects::MemoryApplyNoEffects;
use counts::apply_admission_counts;
use record_builder::apply_admission_record;

pub fn accepted_memory_projection_import_apply_admissions(
    inputs: impl IntoIterator<Item = AcceptedMemoryProjectionImportApplyAdmissionInput>,
) -> AcceptedMemoryProjectionImportApplyAdmissionSet {
    let records: Vec<_> = inputs.into_iter().map(apply_admission_record).collect();
    let counts = apply_admission_counts(&records);

    AcceptedMemoryProjectionImportApplyAdmissionSet {
        records,
        counts,
        no_effects: MemoryApplyNoEffects::none(),
    }
}
