//! Task-level model preference types.

use nucleus_agent_protocol::ModelRouteOverride;

/// Model and route preferences supplied by a task.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskModelPreferences {
    pub preference_mode: TaskModelPreferenceMode,
    pub route_preferences: Vec<TaskRoutePreference>,
    pub scoped_overrides: Vec<ModelRouteOverride>,
    pub notes: Vec<String>,
}

/// How strongly task preferences should influence selection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TaskModelPreferenceMode {
    NoPreference,
    PreferListed,
    RequireOneOfListed,
    InheritProjectDefault,
    InheritSessionDefault,
}

/// Ordered route preference for a task.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskRoutePreference {
    pub route_ref: String,
    pub weight: TaskPreferenceWeight,
    pub reason: Option<String>,
}

/// Coarse preference weight before scheduler policy exists.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TaskPreferenceWeight {
    Low,
    Normal,
    High,
    Required,
}
