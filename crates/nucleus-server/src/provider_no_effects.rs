//! Shared provider no-effects declaration.
//!
//! Admission-only provider gates assert that no side effects ran. Instead of
//! stamping the same eight `false` booleans into every record, diagnostics,
//! and DTO struct, those structs embed this one (serde-flattened, so wire
//! shapes keep the same flat field names).

use serde::{Deserialize, Serialize};

/// The standard "nothing executed" claim for provider admission surfaces.
///
/// `Default` is the honest state (everything false). A gate that actually
/// performs an effect must not use this type for that flag.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProviderNoEffects {
    pub credential_resolution_performed: bool,
    pub provider_network_call_performed: bool,
    pub provider_write_executed: bool,
    pub callback_effect_executed: bool,
    pub interruption_effect_executed: bool,
    pub recovery_effect_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_provider_payload_retained: bool,
}

impl ProviderNoEffects {
    /// All effects denied — the only state admission-only gates may record.
    pub fn none() -> Self {
        Self::default()
    }

    /// True when every effect flag is false.
    pub fn is_none_executed(&self) -> bool {
        *self == Self::default()
    }
}
