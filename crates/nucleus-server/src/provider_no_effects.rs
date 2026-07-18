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

/// Runtime-family variant of [`ProviderNoEffects`]: identical claim set but
/// these families record a general `provider_effect_executed` flag instead
/// of `provider_write_executed`. Kept as its own struct so wire field names
/// stay exactly as clients already read them.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ProviderRuntimeNoEffects {
    pub credential_resolution_performed: bool,
    pub provider_network_call_performed: bool,
    pub provider_effect_executed: bool,
    pub callback_effect_executed: bool,
    pub interruption_effect_executed: bool,
    pub recovery_effect_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_provider_payload_retained: bool,
}

impl ProviderRuntimeNoEffects {
    /// All effects denied — the only state admission-only gates may record.
    pub fn none() -> Self {
        Self::default()
    }

    /// True when every effect flag is false.
    pub fn is_none_executed(&self) -> bool {
        *self == Self::default()
    }
}

/// Convergence local-snap family: authority denials plus retention claim.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConvergenceSnapNoAuthority {
    pub command_spawn_permitted: bool,
    pub local_snap_creation_permitted: bool,
    pub object_upload_permitted: bool,
    pub publication_permitted: bool,
    pub lane_sync_permitted: bool,
    pub provider_write_permitted: bool,
    pub task_mutation_permitted: bool,
    pub raw_material_retained: bool,
}

/// Convergence runner/publication family: authority denials plus retention.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConvergenceRunnerNoAuthority {
    pub runner_invocation_permitted: bool,
    pub provider_handoff_permitted: bool,
    pub snapshot_creation_permitted: bool,
    pub publish_permitted: bool,
    pub publication_review_permitted: bool,
    pub provider_write_permitted: bool,
    pub task_mutation_permitted: bool,
    pub raw_material_retained: bool,
}

/// Accepted-memory apply family: no memory, projection, scm, provider, or
/// scheduling effects ran.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct MemoryApplyNoEffects {
    pub active_memory_apply_performed: bool,
    pub projection_write_performed: bool,
    pub scm_effect_performed: bool,
    pub embedding_available: bool,
    pub provider_sync_available: bool,
    pub automatic_extraction_performed: bool,
    pub task_mutation_performed: bool,
    pub agent_scheduling_performed: bool,
    pub ui_effect_performed: bool,
}

/// SCM/forge dry-run family: no forge or provider effects ran and no raw
/// command output was retained.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct ForgeScmNoEffects {
    pub pull_request_created: bool,
    pub forge_effect_executed: bool,
    pub provider_effect_executed: bool,
    pub callback_effect_executed: bool,
    pub interruption_effect_executed: bool,
    pub recovery_effect_executed: bool,
    pub task_mutation_executed: bool,
    pub raw_output_retained: bool,
}

macro_rules! no_effects_helpers {
    ($($name:ident),+) => {$(
        impl $name {
            /// All flags false — the only state admission-only gates record.
            pub fn none() -> Self {
                Self::default()
            }

            /// True when every flag is false.
            pub fn is_none_executed(&self) -> bool {
                *self == Self::default()
            }
        }
    )+};
}

no_effects_helpers!(
    ConvergenceSnapNoAuthority,
    ConvergenceRunnerNoAuthority,
    MemoryApplyNoEffects,
    ForgeScmNoEffects
);

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
