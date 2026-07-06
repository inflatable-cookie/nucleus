//! Pure review commands for accepted-memory import-apply admissions.
//!
//! Review receipts grant no apply authority by themselves. They only record an
//! operator decision over a stopped apply/admission record.

mod blockers;
mod counts;
mod record_builder;
mod refs;
mod types;

pub use refs::accepted_memory_import_apply_review_receipt_ref;
pub use types::*;

use counts::review_receipt_counts;
use record_builder::review_receipt;

pub fn accepted_memory_import_apply_review_receipts(
    inputs: impl IntoIterator<Item = AcceptedMemoryImportApplyReviewInput>,
) -> AcceptedMemoryImportApplyReviewSet {
    let receipts: Vec<_> = inputs.into_iter().map(review_receipt).collect();
    let counts = review_receipt_counts(&receipts);

    AcceptedMemoryImportApplyReviewSet {
        receipts,
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
