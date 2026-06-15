//! Adapter instance configuration types.

/// Configuration entry for one adapter instance.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdapterConfigEntry {
    pub key: String,
    pub value: AdapterConfigValue,
    pub scope: AdapterConfigScope,
}

/// Configuration value without secret material.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AdapterConfigValue {
    String(String),
    Bool(bool),
    Integer(i64),
    Path(String),
    SecretRef(String),
}

/// Where an adapter config entry applies.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AdapterConfigScope {
    Driver,
    Instance,
    Project,
    Session,
}
