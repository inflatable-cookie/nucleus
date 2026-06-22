//! Client-safe readiness overview composed from provider read-intent evidence.

mod composer;
mod types;

pub use composer::forge_readiness_overview;
pub use types::{
    ForgeReadinessOverview, ForgeReadinessOverviewInput, ForgeReadinessOverviewStatus,
};

#[cfg(test)]
mod tests;
