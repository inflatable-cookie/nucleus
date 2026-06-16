//! Dev-only contract fixture vocabulary for Nucleus tests.
//!
//! This crate is test support only. It does not implement production adapters,
//! spawn processes, open network connections, read credentials, execute shell
//! commands, or provide production APIs.

pub mod command_policy;
pub mod fake_adapters;
pub mod scenarios;
pub mod scm_forge;

pub use command_policy::CommandPolicyFixtureProfile;
pub use fake_adapters::{FakeCommandPolicyAdapter, FakeForgeAdapter, FakeScmAdapter};
pub use scenarios::{
    FakeAdapterScenario, FakeScenarioEvent, FakeScenarioStep, FakeScenarioStepKind,
};
pub use scm_forge::ScmForgeFixtureProfile;
