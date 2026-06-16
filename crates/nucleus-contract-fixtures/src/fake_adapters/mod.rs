//! Dev-only fake adapter skeletons.
//!
//! These types are deterministic test fixtures. They do not implement
//! production adapter traits, execute commands, open network connections, read
//! credentials, or persist state.

pub mod command_policy;
pub mod forge;
pub mod scm;

pub use command_policy::FakeCommandPolicyAdapter;
pub use forge::FakeForgeAdapter;
pub use scm::FakeScmAdapter;
