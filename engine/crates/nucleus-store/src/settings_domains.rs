use std::{
    collections::{BTreeMap, BTreeSet},
    net::IpAddr,
    path::PathBuf,
};

use longhorn_config::{DomainIssue, StorageClass};
use nucleus_core::profiles::{Profile, UsageLevel};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::{Host, Url};

use crate::settings::SettingsValue;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NamedProfile {
    pub name: String,
    pub selection: Profile,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    #[serde(default = "enabled_by_default", skip_serializing_if = "enabled")]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_instance_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode_id: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub feature_values: BTreeMap<String, Value>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub notes: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub unrated: bool,
}

const fn enabled_by_default() -> bool {
    true
}

#[allow(
    clippy::trivially_copy_pass_by_ref,
    reason = "Serde passes fields by reference"
)]
const fn enabled(value: &bool) -> bool {
    *value
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Profiles {
    pub profiles: Vec<NamedProfile>,
    #[serde(default)]
    pub paused_groups: BTreeSet<String>,
}

impl SettingsValue for Profiles {
    const ID: &'static str = "nucleus.engine.profiles";
    const FILE: &'static str = "profiles.json";
    const CLASS: StorageClass = StorageClass::UserConfig;

    fn discard_retired_fields(value: &mut Value) {
        if let Some(profiles) = value.get_mut("profiles").and_then(Value::as_array_mut) {
            for profile in profiles.iter_mut().filter_map(Value::as_object_mut) {
                profile.remove("roles");
                profile.remove("scopes");
            }
        }
    }

    fn validate(&self) -> Result<(), DomainIssue> {
        let mut ids = std::collections::BTreeSet::new();
        for profile in &self.profiles {
            check(
                key(&profile.selection.id)
                    && ids.insert(&profile.selection.id)
                    && text(&profile.name)
                    && (profile.selection.model.is_empty() || text(&profile.selection.model)),
                "profile",
                "each profile needs a stable ID and name, and any model must be valid",
            )?;
            check(
                profile
                    .group
                    .as_ref()
                    .is_none_or(|group| text(group) && group.trim() == group),
                "group",
                "subscription group names must be nonempty and trimmed",
            )?;
        }
        check(
            self.paused_groups
                .iter()
                .all(|group| text(group) && group.trim() == group),
            "pausedGroups",
            "paused subscription group names must be nonempty and trimmed",
        )
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DispatchSettings {
    pub usage: UsageLevel,
    pub usage_until_ms: Option<u64>,
    #[serde(alias = "slots")]
    pub global_slots: u32,
    #[serde(default = "default_project_slots")]
    pub project_default_slots: u32,
    #[serde(default)]
    pub project_slot_overrides: BTreeMap<String, u32>,
    #[serde(default = "default_thread_retention_days")]
    pub thread_retention_days: u32,
    #[serde(default = "default_thread_retention_interval_hours")]
    pub thread_retention_interval_hours: u32,
    #[serde(default)]
    pub mode: DispatchMode,
}

/// The operator's global dispatch switch. It gates launches only; a stored
/// task never changes because of it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DispatchMode {
    /// Launch as usual.
    #[default]
    Running,
    /// Start no task that has never launched. Started tasks keep going.
    Held,
    /// Start no run. Running turns finish.
    Paused,
    /// Start no run and stop running turns. Running again relaunches them.
    Stopped,
}

impl DispatchMode {
    /// Whether this mode lets a task start its next run.
    #[must_use]
    pub const fn allows_launch(self, first_launch: bool) -> bool {
        match self {
            Self::Running => true,
            Self::Held => !first_launch,
            Self::Paused | Self::Stopped => false,
        }
    }
}

const fn default_project_slots() -> u32 {
    5
}

const fn default_thread_retention_days() -> u32 {
    3
}

const fn default_thread_retention_interval_hours() -> u32 {
    12
}

impl Default for DispatchSettings {
    fn default() -> Self {
        Self {
            usage: UsageLevel::Normal,
            usage_until_ms: None,
            global_slots: 32,
            project_default_slots: default_project_slots(),
            project_slot_overrides: BTreeMap::new(),
            thread_retention_days: default_thread_retention_days(),
            thread_retention_interval_hours: default_thread_retention_interval_hours(),
            mode: DispatchMode::Running,
        }
    }
}

impl DispatchSettings {
    /// Resolve the limit in force for a registered project.
    #[must_use]
    pub fn project_slots(&self, project_key: &str) -> u32 {
        self.project_slot_overrides
            .get(project_key)
            .copied()
            .unwrap_or(self.project_default_slots)
    }

    #[must_use]
    pub fn effective_usage(&self, now_ms: u64) -> UsageLevel {
        match self.usage_until_ms {
            Some(end) if end <= now_ms => UsageLevel::Normal,
            _ => self.usage,
        }
    }
}

impl SettingsValue for DispatchSettings {
    const ID: &'static str = "nucleus.engine.dispatch";
    const FILE: &'static str = "dispatch.json";
    const CLASS: StorageClass = StorageClass::UserConfig;

    fn discard_retired_fields(value: &mut Value) {
        if let Some(fields) = value.as_object_mut() {
            for key in [
                "maxLoad",
                "max_load",
                "allowanceMinutes",
                "allowance_minutes",
                "hostConcurrency",
                "host_concurrency",
                "legacyLimitsImported",
                "providerLimitCooldownSeconds",
                "provider_limit_cooldown_seconds",
            ] {
                fields.remove(key);
            }
        }
    }

    fn validate(&self) -> Result<(), DomainIssue> {
        check(self.global_slots > 0, "dispatch", "use positive slots")?;
        check(
            (1..=32).contains(&self.project_default_slots)
                && self
                    .project_slot_overrides
                    .iter()
                    .all(|(id, &slots)| key(id) && slots <= 64),
            "projectSlots",
            "use 1–32 default project slots and 0–64 per override",
        )?;
        check(
            (1..=90).contains(&self.thread_retention_days)
                && (1..=168).contains(&self.thread_retention_interval_hours),
            "threadRetention",
            "use 1–90 retention days and 1–168 hours between sweeps",
        )?;
        check(
            self.usage_until_ms.is_none()
                || (self.usage_until_ms != Some(0)
                    && matches!(
                        self.usage,
                        UsageLevel::High | UsageLevel::ExtraHigh | UsageLevel::Maximum
                    )),
            "usage",
            "only High, Extra high and Maximum can have an end time",
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositorySettings {
    /// Canonical GitHub repository identity, such as `owner/repo`.
    pub origin: String,
    pub path: PathBuf,
    pub base: String,
    /// T3 project registered at this repository's exact checkout root.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_project: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_project_title: Option<String>,
    /// Exact T3 callers enrolled for this route.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub planner_threads: Vec<String>,
}

impl<'de> Deserialize<'de> for RepositorySettings {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct SavedRepository {
            origin: String,
            path: PathBuf,
            base: String,
            #[serde(default)]
            host_project: Option<String>,
            #[serde(default)]
            host_project_title: Option<String>,
            #[serde(default)]
            planner_threads: Vec<String>,
            #[serde(default, rename = "requiredChecks")]
            _retired_required_checks: Option<serde::de::IgnoredAny>,
            // The hung-tool limit is retired. A stored value loads and the next save drops it.
            #[serde(default, rename = "hungToolMinutes")]
            _retired_hung_tool_minutes: Option<serde::de::IgnoredAny>,
        }
        let saved = SavedRepository::deserialize(deserializer)?;
        Ok(Self {
            origin: saved.origin,
            path: saved.path,
            base: saved.base,
            host_project: saved.host_project,
            host_project_title: saved.host_project_title,
            planner_threads: saved.planner_threads,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planner_claim: Option<PlannerClaim>,
    pub name: String,
    pub archived: bool,
    pub repositories: Vec<RepositorySettings>,
}

/// A project message preference. The occurrence lets a restart finish its replacement notice.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlannerClaim {
    pub thread: String,
    pub occurrence: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replaced: Option<String>,
}

impl<'de> Deserialize<'de> for ProjectSettings {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct SavedProject {
            #[serde(default, rename = "plannerClaim")]
            planner_claim: Option<PlannerClaim>,
            name: String,
            #[serde(default, rename = "slots")]
            _retired_slots: Option<serde::de::IgnoredAny>,
            #[serde(default)]
            archived: bool,
            #[serde(default)]
            repositories: Vec<RepositorySettings>,
        }
        let saved = SavedProject::deserialize(deserializer)?;
        Ok(Self {
            planner_claim: saved.planner_claim,
            name: saved.name,
            archived: saved.archived,
            repositories: saved.repositories,
        })
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Projects {
    pub projects: BTreeMap<String, ProjectSettings>,
    /// Durable removals by project ID, including the repositories they retired.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub removed: BTreeMap<String, RemovedProject>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemovedProject {
    pub repositories: Vec<RemovedRepository>,
    /// Origins still barred from first-contact enrollment. The receipt stays immutable.
    pub blocked_origins: BTreeSet<String>,
    pub cleanup_pending: bool,
    pub digest: String,
    pub reason: String,
    pub removed_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RemovedRepository {
    pub origin: String,
    pub path: PathBuf,
}

impl Projects {
    #[must_use]
    pub fn removed_origin(&self, origin: &str) -> bool {
        let origin = origin.to_ascii_lowercase();
        self.removed
            .values()
            .any(|project| project.blocked_origins.contains(&origin))
    }

    /// Release an explicitly registered origin from the first-contact fence.
    ///
    /// # Errors
    /// Returns a conflict if the previous project's planning cleanup is pending.
    pub fn restore_origin(&mut self, origin: &str) -> Result<(), crate::StorageError> {
        let origin = origin.to_ascii_lowercase();
        for removed in self.removed.values_mut() {
            if removed.blocked_origins.contains(&origin) && removed.cleanup_pending {
                return Err(crate::StorageError::SettingsConflict);
            }
            removed.blocked_origins.remove(&origin);
        }
        Ok(())
    }

    #[must_use]
    pub fn has_pending_removals(&self) -> bool {
        self.removed.values().any(|removed| removed.cleanup_pending)
    }
}

impl SettingsValue for Projects {
    const ID: &'static str = "nucleus.engine.projects";
    const FILE: &'static str = "projects.json";
    // This registry belongs to the engine profile. It spans repository roots
    // so a reassignment can commit as one write.
    const CLASS: StorageClass = StorageClass::MachineState;

    fn validate(&self) -> Result<(), DomainIssue> {
        let mut origins = std::collections::BTreeSet::new();
        let mut host_projects = std::collections::BTreeSet::new();
        let mut planners = std::collections::BTreeSet::new();
        for (id, project) in &self.projects {
            check(
                key(id)
                    && text(&project.name)
                    && self
                        .removed
                        .get(id)
                        .is_none_or(|removed| !removed.cleanup_pending),
                "project",
                "each project needs a stable ID and name",
            )?;
            for repo in &project.repositories {
                check(
                    repo.origin
                        .split_once('/')
                        .is_some_and(|(owner, name)| key(owner) && key(name))
                        && !self.removed_origin(&repo.origin)
                        && origins.insert(repo.origin.to_ascii_lowercase())
                        && absolute_path(&repo.path)
                        && branch(&repo.base)
                        && repo.host_project.as_deref().is_none_or(|id| {
                            text(id) && id.trim() == id && host_projects.insert(id)
                        }),
                    "repository",
                    "each repository needs a unique GitHub origin, absolute path and base",
                )?;
                check(
                    repo.planner_threads.iter().all(|id| {
                        repo.host_project.is_some()
                            && text(id)
                            && id.trim() == id
                            && planners.insert(id.as_str())
                    }),
                    "routing",
                    "a planner binding requires its native project",
                )?;
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct T3Settings {
    pub endpoint: Url,
    /// An environment key identifying a credential supplied by the launcher.
    pub credential_ref: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Hosts {
    pub t3: Option<T3Settings>,
}

impl SettingsValue for Hosts {
    const ID: &'static str = "nucleus.engine.hosts";
    const FILE: &'static str = "hosts.json";
    const CLASS: StorageClass = StorageClass::MachineState;

    fn validate(&self) -> Result<(), DomainIssue> {
        if let Some(t3) = &self.t3 {
            let endpoint = &t3.endpoint;
            let loopback = match endpoint.host() {
                Some(Host::Domain(host)) => host == "localhost",
                Some(Host::Ipv4(ip)) => IpAddr::V4(ip).is_loopback(),
                Some(Host::Ipv6(ip)) => IpAddr::V6(ip).is_loopback(),
                None => false,
            };
            check(
                matches!(endpoint.scheme(), "http" | "https")
                    && loopback
                    && endpoint.username().is_empty()
                    && endpoint.password().is_none()
                    && endpoint.path() == "/"
                    && endpoint.query().is_none()
                    && endpoint.fragment().is_none(),
                "endpoint",
                "T3 requires a loopback HTTP endpoint without credentials, a path or a query",
            )?;
            let reference = t3.credential_ref.as_bytes();
            check(
                reference.len() <= 128
                    && reference.first().is_some_and(u8::is_ascii_uppercase)
                    && reference
                        .iter()
                        .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || *c == b'_'),
                "credential",
                "supply a credential environment key",
            )?;
        }
        Ok(())
    }
}

fn absolute_path(path: &std::path::Path) -> bool {
    path.is_absolute()
        && path
            .to_str()
            .is_some_and(|path| !path.chars().any(char::is_control))
        && path
            .components()
            .all(|part| !matches!(part, std::path::Component::ParentDir))
}

fn branch(value: &str) -> bool {
    text(value)
        && value != "@"
        && !value.starts_with('-')
        && !value.ends_with('.')
        && !value.contains("..")
        && !value.contains("@{")
        && !value.contains([' ', '~', '^', ':', '?', '*', '[', '\\'])
        && value.split('/').all(|part| {
            !part.is_empty()
                && !part.starts_with('.')
                && part
                    .rsplit_once('.')
                    .is_none_or(|(_, suffix)| suffix != "lock")
        })
}

fn key(value: &str) -> bool {
    !value.is_empty()
        && !matches!(value, "." | "..")
        && value.len() <= 240
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.'))
}

fn text(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 240 && !value.chars().any(char::is_control)
}

pub(super) fn check(test: bool, code: &str, message: &str) -> Result<(), DomainIssue> {
    if test {
        Ok(())
    } else {
        Err(DomainIssue::new(code, message))
    }
}

#[cfg(test)]
mod dispatch_mode_tests {
    use super::{DispatchMode, DispatchSettings};

    #[test]
    fn dispatch_mode_gates_first_launches_and_every_launch() {
        assert!(DispatchMode::Running.allows_launch(true));
        assert!(!DispatchMode::Held.allows_launch(true));
        assert!(DispatchMode::Held.allows_launch(false));
        for mode in [DispatchMode::Paused, DispatchMode::Stopped] {
            assert!(!mode.allows_launch(true) && !mode.allows_launch(false));
        }
    }

    #[test]
    fn a_saved_domain_without_a_mode_reads_as_running() {
        let saved: DispatchSettings = serde_json::from_value(serde_json::json!({
            "usage": "normal", "usageUntilMs": null, "slots": 2
        }))
        .expect("dispatch settings");
        assert_eq!(saved.mode, DispatchMode::Running);
        let stopped: DispatchSettings = serde_json::from_value(serde_json::json!({
            "usage": "normal", "usageUntilMs": null, "slots": 2, "mode": "stopped"
        }))
        .expect("dispatch settings");
        assert_eq!(stopped.mode, DispatchMode::Stopped);
    }
}

#[cfg(test)]
mod retired_repository_tests {
    use super::Projects;

    #[test]
    fn a_saved_repository_drops_the_retired_hung_tool_limit() {
        let saved: Projects = serde_json::from_value(serde_json::json!({
            "projects": {"alpha": {"name": "Alpha", "repositories": [{
                "origin": "example/alpha", "path": "/work/alpha", "base": "main",
                "hungToolMinutes": 30
            }]}}
        }))
        .expect("a retired hung-tool limit still loads");
        let saved = serde_json::to_value(saved).expect("current projects");
        let repository = &saved["projects"]["alpha"]["repositories"][0];
        assert_eq!(repository["origin"], "example/alpha");
        assert!(repository.get("hungToolMinutes").is_none());
    }
}
