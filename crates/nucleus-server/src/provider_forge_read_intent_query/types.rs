use crate::provider_no_effects::ProviderRuntimeNoEffects;
use serde::{Deserialize, Serialize};

use crate::{ForgeReadIntentProjectionControlDto, ForgeReadIntentProjectionSet};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ForgeReadIntentQueryResult {
    pub query_id: String,
    pub projection: ForgeReadIntentProjectionSet,
    pub source_counts: ForgeReadIntentQuerySourceCounts,
    pub control: ForgeReadIntentQueryControlDto,
    #[serde(flatten)]
    pub no_effects: ProviderRuntimeNoEffects,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ForgeReadIntentQuerySourceCounts {
    pub credential_status_records: usize,
    pub repository_metadata_records: usize,
    pub pull_request_records: usize,
    pub status_check_records: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ForgeReadIntentQueryControlDto {
    pub dto_id: String,
    pub projection_control: ForgeReadIntentProjectionControlDto,
    pub source_counts: ForgeReadIntentQuerySourceCounts,
    #[serde(flatten)]
    pub no_effects: ProviderRuntimeNoEffects,
}
