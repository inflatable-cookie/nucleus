//! Effigy project integration records for native personas.
//!
//! These records describe discovered or configured Effigy surfaces. They do
//! not run Effigy, parse live command output, edit manifests, or execute
//! selectors.

mod commands;
mod health;
mod integration;
mod repair;
mod safety;
mod validation;

pub use commands::{
    NativeEffigyDoctorCommandStatus, NativeEffigyDoctorCommandSummary,
    NativeEffigyTestPlanCommandStatus, NativeEffigyTestPlanCommandSummary,
};
pub use health::{NativeEffigyHealthStatus, NativeEffigyHealthSummary};
pub use integration::{
    NativeEffigyCommandScopeHint, NativeEffigyEvidenceRef, NativeEffigyIntegrationStatus,
    NativeEffigyManifestRef, NativeEffigyProjectIntegration, NativeEffigyScope,
    NativeEffigySelectorKind, NativeEffigySelectorRecord, NativeEffigySelectorRef,
    NativeEffigySelectorRefreshStatus, NativeEffigySelectorRefreshSummary,
};
pub use repair::{
    NativeEffigyRepairHint, NativeEffigyRepairHintKind, NativeEffigyRepairSource,
    NativeEffigyRepairSynthesis, NativeEffigyRepairSynthesisStatus,
};
pub use validation::{
    NativeEffigyPlannedSelector, NativeEffigyValidationPlanStatus,
    NativeEffigyValidationPlanSummary, NativeEffigyValidationPurpose,
};

#[cfg(test)]
mod tests;
