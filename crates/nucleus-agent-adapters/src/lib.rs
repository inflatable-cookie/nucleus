//! Adapter registry and configured adapter instance types.
//!
//! This crate names adapter registration state only. It does not implement
//! provider adapters, process spawning, SDK bridges, ACP clients, or CLI/PTTY
//! control yet.

pub mod config;
pub mod registry;
pub mod status;

pub use config::{AdapterConfigEntry, AdapterConfigScope, AdapterConfigValue};
pub use registry::{AdapterInstanceRecord, AdapterRegistry, AdapterRegistryId};
pub use status::{AdapterHealth, AdapterLifecycleStatus, AdapterReadiness};
