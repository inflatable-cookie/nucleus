//! Read-only accepted-memory review/product readiness projection.
//!
//! This projection composes existing accepted-memory diagnostics into one
//! product-consumable view. It does not create a new authority source or run
//! memory, projection, SCM, search, provider, task, agent, or UI effects.

mod counts;
mod records;
mod types;

pub use types::*;

use crate::accepted_memory_projection::AcceptedMemoryProjection;
use crate::accepted_memory_projection_import_apply_diagnostics::AcceptedMemoryProjectionImportApplyDiagnostics;
use crate::accepted_memory_projection_import_diagnostics::AcceptedMemoryProjectionImportDiagnostics;
use crate::accepted_memory_projection_write_diagnostics::AcceptedMemoryProjectionWriteDiagnostics;
use crate::provider_no_effects::MemoryApplyNoEffects;

impl AcceptedMemoryReviewReadiness {
    pub fn from_diagnostics(
        accepted_memory: AcceptedMemoryProjection,
        projection_writes: AcceptedMemoryProjectionWriteDiagnostics,
        imports: AcceptedMemoryProjectionImportDiagnostics,
        import_apply: AcceptedMemoryProjectionImportApplyDiagnostics,
    ) -> Self {
        let mut records = Vec::new();
        records.extend(records::from_accepted_memories(&accepted_memory.memories));
        records.extend(records::from_projection_writes(&projection_writes.entries));
        records.extend(records::from_import_candidates(&imports.candidates));
        records.extend(records::from_import_admissions(&imports.admissions));
        records.extend(records::from_import_conflicts(&imports.conflicts));
        records.extend(records::from_apply_admissions(&import_apply.records));

        let counts = AcceptedMemoryReviewReadinessCounts::from_records(&records);

        Self {
            project_id: accepted_memory.project_id,
            records,
            counts,
            no_effects: MemoryApplyNoEffects::none(),
        }
    }
}
