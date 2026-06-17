//! Type-only Codex app-server lifecycle and fixture-event mapping.

mod fixtures;
mod lifecycle;
mod types;

#[cfg(test)]
mod tests;

pub use fixtures::project_codex_app_server_fixture;
pub use lifecycle::codex_app_server_lifecycle_mappings;
pub use types::{
    CodexAppServerEventFixture, CodexAppServerFixturePayload, CodexAppServerFixtureProjection,
    CodexAppServerProviderRefs, CodexAppServerSessionBinding, CodexFixtureMappingError,
    CodexIdSource, CodexLifecycleActionMapping, CodexRecoveryFallback, CodexRuntimeReceiptFixture,
    CodexRuntimeReceiptStatus, CodexServerOwnedWaitState,
};
