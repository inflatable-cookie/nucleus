use nucleus_core::profiles::{Effort, Profile, Provider};
use serde_json::Value;

use crate::{HostError, ModelOption, RoleProfile, available};

pub struct ProfileCatalog(Vec<Value>);

pub struct ProfileOffer {
    native: RoleProfile,
    efforts: Vec<(Effort, ModelOption)>,
}

impl ProfileOffer {
    #[must_use]
    pub fn instance(&self) -> &str {
        &self.native.instance_id
    }

    pub fn efforts(&self) -> impl Iterator<Item = Effort> + '_ {
        self.efforts.iter().map(|(effort, _)| *effort)
    }

    /// Translate the exact effort chosen by the profile policy.
    ///
    /// # Errors
    /// Returns an error if the model did not offer the effort.
    pub fn resolve(&self, effort: Option<Effort>) -> Result<RoleProfile, HostError> {
        let mut native = self.native.clone();
        if let Some(effort) = effort {
            let (_, option) = self
                .efforts
                .iter()
                .find(|(offered, _)| *offered == effort)
                .ok_or(HostError::Configuration)?;
            native.options.push(option.clone());
        }
        Ok(native)
    }
}

impl ProfileCatalog {
    pub(super) fn parse(mut config: Value) -> Result<Self, HostError> {
        if config
            .pointer("/environment/orchestrationProtocolVersion")
            .and_then(Value::as_u64)
            != Some(2)
        {
            return Err(HostError::Protocol);
        }
        let Value::Array(providers) = config["providers"].take() else {
            return Err(HostError::Protocol);
        };
        Ok(Self(providers))
    }

    #[must_use]
    pub fn supports(&self, profile: &RoleProfile) -> bool {
        self.0.iter().any(|provider| available(provider, profile))
    }

    pub(super) fn supports_parent(&self, instance: &str) -> bool {
        let profile = RoleProfile {
            instance_id: instance.into(),
            model: "nucleus".into(),
            runtime_mode: "full-access".into(),
            options: Vec::new(),
        };
        self.0
            .iter()
            .any(|provider| provider["driver"] == "acpRegistry" && available(provider, &profile))
    }

    #[must_use]
    pub fn offer(&self, profile: &Profile, runtime_mode: &str) -> Option<ProfileOffer> {
        let driver = driver(profile.provider);
        self.0
            .iter()
            .filter_map(|provider| {
                let instance = provider["instanceId"].as_str()?;
                if instance.trim().is_empty()
                    || provider["driver"].as_str().unwrap_or(instance) != driver
                {
                    return None;
                }
                let native = RoleProfile {
                    instance_id: instance.into(),
                    model: profile.model.clone(),
                    runtime_mode: runtime_mode.into(),
                    options: Vec::new(),
                };
                let model = provider["models"]
                    .as_array()?
                    .iter()
                    .find(|model| model["slug"] == profile.model)?;
                available(provider, &native).then(|| {
                    let efforts = offered_efforts(model);
                    (
                        instance != driver,
                        instance,
                        ProfileOffer { native, efforts },
                    )
                })
            })
            .min_by_key(|(custom, instance, _)| (*custom, *instance))
            .map(|(_, _, offer)| offer)
    }
}

const fn driver(provider: Provider) -> &'static str {
    match provider {
        Provider::Codex => "codex",
        Provider::Claude => "claudeAgent",
        Provider::Pi => "pi",
        Provider::Grok => "grok",
        Provider::Cursor => "cursor",
        Provider::Opencode => "opencode",
        Provider::Copilot => "copilot",
        Provider::Omp => "omp",
        Provider::Antigravity => "antigravity",
        Provider::Muse => "muse",
        Provider::Fx => "fx",
        Provider::Kiro => "kiro",
    }
}

fn offered_efforts(model: &Value) -> Vec<(Effort, ModelOption)> {
    let Some(descriptors) = model
        .pointer("/capabilities/optionDescriptors")
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    let mut carriers = descriptors.iter().filter(|option| {
        option["type"] == "select"
            && (option["role"] == "reasoning"
                || matches!(
                    option["id"].as_str(),
                    Some(
                        "reasoningEffort"
                            | "effort"
                            | "reasoning"
                            | "variant"
                            | "reasoning_effort"
                            | "thinking_level"
                            | "thinking"
                    )
                ))
    });
    let Some(carrier) = carriers.next() else {
        return Vec::new();
    };
    let (Some(id), Some(choices)) = (carrier["id"].as_str(), carrier["options"].as_array()) else {
        return Vec::new();
    };
    if carriers.next().is_some() {
        return Vec::new();
    }
    choices
        .iter()
        .filter_map(|choice| {
            let value = choice["id"].as_str()?;
            let effort = if value == "ultrathink" {
                Effort::Ultra
            } else {
                serde_json::from_value(choice["id"].clone()).ok()?
            };
            Some((
                effort,
                ModelOption {
                    id: id.into(),
                    value: value.into(),
                },
            ))
        })
        .collect()
}
