use std::{
    collections::{BTreeMap, BTreeSet},
    net::IpAddr,
    path::PathBuf,
};

use longhorn_config::{DomainIssue, StorageClass};
use nucleus_core::profiles::{Profile, UsageLevel};
use serde::{Deserialize, Serialize};
use url::{Host, Url};

use crate::settings::SettingsValue;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NamedProfile {
    pub name: String,
    pub selection: Profile,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
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

    fn validate(&self) -> Result<(), DomainIssue> {
        let mut ids = std::collections::BTreeSet::new();
        for profile in &self.profiles {
            check(
                key(&profile.selection.id)
                    && ids.insert(&profile.selection.id)
                    && text(&profile.name)
                    && text(&profile.selection.model),
                "profile",
                "each profile needs a stable ID, name and model",
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
    pub slots: u32,
    pub host_concurrency: u32,
    pub allowance_minutes: Option<u32>,
    #[serde(default = "default_provider_limit_cooldown_seconds")]
    pub provider_limit_cooldown_seconds: u32,
}

const fn default_provider_limit_cooldown_seconds() -> u32 {
    300
}

impl Default for DispatchSettings {
    fn default() -> Self {
        Self {
            usage: UsageLevel::Normal,
            usage_until_ms: None,
            slots: 1,
            host_concurrency: 1,
            allowance_minutes: None,
            provider_limit_cooldown_seconds: default_provider_limit_cooldown_seconds(),
        }
    }
}

impl DispatchSettings {
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
    const RETIRED_KEYS: &'static [&'static str] = &["maxLoad", "max_load"];

    fn validate(&self) -> Result<(), DomainIssue> {
        check(
            self.slots > 0 && self.host_concurrency == 1 && self.allowance_minutes != Some(0),
            "dispatch",
            "use positive slots and allowance. The host lane has one call slot",
        )?;
        check(
            self.provider_limit_cooldown_seconds > 0,
            "providerLimitCooldownSeconds",
            "the provider limit cooldown must be positive",
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepositorySettings {
    /// Canonical GitHub repository identity, such as `owner/repo`.
    pub origin: String,
    pub path: PathBuf,
    pub base: String,
    #[serde(default)]
    pub required_checks: Vec<String>,
    #[serde(default = "default_hung_tool_minutes")]
    pub hung_tool_minutes: u32,
}

const fn default_hung_tool_minutes() -> u32 {
    30
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectSettings {
    pub name: String,
    pub slots: u32,
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub repositories: Vec<RepositorySettings>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Projects {
    pub projects: BTreeMap<String, ProjectSettings>,
}

impl SettingsValue for Projects {
    const ID: &'static str = "nucleus.engine.projects";
    const FILE: &'static str = "projects.json";
    // This registry belongs to the engine profile. It spans repository roots
    // so a reassignment can commit as one write.
    const CLASS: StorageClass = StorageClass::MachineState;

    fn validate(&self) -> Result<(), DomainIssue> {
        let mut origins = std::collections::BTreeSet::new();
        for (id, project) in &self.projects {
            check(
                key(id) && text(&project.name) && project.slots > 0,
                "project",
                "each project needs a stable ID, name and positive slot limit",
            )?;
            for repo in &project.repositories {
                check(
                    repo.origin
                        .split_once('/')
                        .is_some_and(|(owner, name)| key(owner) && key(name))
                        && origins.insert(repo.origin.to_ascii_lowercase())
                        && absolute_path(&repo.path)
                        && branch(&repo.base)
                        && repo.hung_tool_minutes > 0,
                    "repository",
                    "each repository needs a unique GitHub origin, absolute path, base and positive hung-tool limit",
                )?;
                check(
                    repo.required_checks.iter().all(|name| text(name))
                        && repo
                            .required_checks
                            .iter()
                            .collect::<std::collections::BTreeSet<_>>()
                            .len()
                            == repo.required_checks.len(),
                    "checks",
                    "GitHub check names must be nonempty and unique",
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
