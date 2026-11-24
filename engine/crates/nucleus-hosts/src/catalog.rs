use std::collections::BTreeMap;

use nucleus_core::profiles::{Effort, Profile, Provider};
use serde_json::{Value, json};

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
    pub fn offer(
        &self,
        profile: &Profile,
        instance_id: Option<&str>,
        mode: &str,
        feature_values: &BTreeMap<String, Value>,
    ) -> Option<ProfileOffer> {
        let driver = driver(profile.provider);
        let runtime_mode = match mode {
            "supervised" => "approval-required",
            "accept-edits" => "auto-accept-edits",
            mode => mode,
        };
        self.0
            .iter()
            .filter_map(|provider| {
                let instance = provider["instanceId"].as_str()?;
                if instance.trim().is_empty()
                    || provider["driver"].as_str().unwrap_or(instance) != driver
                    || instance_id.is_some_and(|required| required != instance)
                {
                    return None;
                }
                let model = provider["models"]
                    .as_array()?
                    .iter()
                    .find(|model| model["slug"] == profile.model)?;
                let native = RoleProfile {
                    instance_id: instance.into(),
                    model: profile.model.clone(),
                    runtime_mode: runtime_mode.into(),
                    options: feature_options(profile.provider, model, feature_values)?,
                };
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

// T3's canonical carriers also appear in hosts/t3code/vocabulary.ts.
fn feature_options(
    provider: Provider,
    model: &Value,
    values: &BTreeMap<String, Value>,
) -> Option<Vec<ModelOption>> {
    let mut options = Vec::new();
    for (key, value) in values {
        let (id, value) = match (provider, key.as_str(), value.as_str()) {
            (_, "speed", Some("default"))
            | (_, "plan-mode" | "ultracode", Some("off"))
            | (_, "cyber-access", Some("standard")) => continue,
            (_, "speed" | "plan-mode" | "ultracode" | "cyber-access", _) if value.is_null() => {
                continue;
            }
            (Provider::Codex, "speed", Some("priority")) => ("serviceTier", json!("priority")),
            (Provider::Claude, "speed", Some("priority")) => ("fastMode", json!(true)),
            (Provider::Claude, "ultracode", Some("on")) => ("ultracode", json!(true)),
            _ => return None,
        };
        let descriptor = model
            .pointer("/capabilities/optionDescriptors")?
            .as_array()?
            .iter()
            .find(|descriptor| descriptor["id"] == id)?;
        let supported = match descriptor["type"].as_str() {
            Some("boolean") => value.is_boolean(),
            Some("select") => descriptor["options"]
                .as_array()
                .is_some_and(|choices| choices.iter().any(|choice| choice["id"] == value)),
            _ => false,
        };
        if !supported {
            return None;
        }
        options.push(ModelOption {
            id: id.into(),
            value,
        });
    }
    Some(options)
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
                    value: json!(value),
                },
            ))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use nucleus_core::profiles::{Capability, Weight};

    #[test]
    fn migrated_options_and_modes_resolve_against_the_exact_native_instance() {
        let model = json!({
            "slug":"fixture-model",
            "capabilities":{"optionDescriptors":[
                {"id":"fastMode","type":"boolean"},
                {"id":"ultracode","type":"boolean"},
                {"id":"effort","type":"select","options":[{"id":"ultrathink"}]}
            ]}
        });
        let catalog = ProfileCatalog::parse(json!({
            "environment":{"orchestrationProtocolVersion":2},
            "providers":[
                {"instanceId":"claudeAgent","enabled":true,"status":"ready","models":[model]},
                {"instanceId":"claude-secondary","driver":"claudeAgent","enabled":true,
                 "status":"ready","supportedRuntimeModes":["auto-accept-edits"],"models":[model]}
            ]
        }))
        .expect("T3 catalog");
        let profile = Profile {
            id: "imported".into(),
            capability: Capability::default(),
            weight: Weight::default(),
            provider: Provider::Claude,
            model: "fixture-model".into(),
            effort: Some(Effort::Ultra),
        };
        let mut features = BTreeMap::from([
            ("speed".into(), json!("priority")),
            ("ultracode".into(), json!("on")),
            ("cyber-access".into(), json!("standard")),
            ("plan-mode".into(), json!("off")),
        ]);
        let instance = Some("claude-secondary");
        let offer = catalog
            .offer(&profile, instance, "accept-edits", &features)
            .expect("native offer");
        let native = offer.resolve(profile.effort).expect("native launch");
        assert_eq!(native.instance_id, "claude-secondary");
        assert_eq!(native.runtime_mode, "auto-accept-edits");
        assert_eq!(
            json!(native.options),
            json!([
                {"id":"fastMode","value":true},
                {"id":"ultracode","value":true},
                {"id":"effort","value":"ultrathink"}
            ])
        );
        assert!(
            catalog
                .offer(&profile, instance, "supervised", &features)
                .is_none()
        );
        assert!(
            catalog
                .offer(&profile, Some("missing"), "accept-edits", &features)
                .is_none()
        );
        features.insert("plan-mode".into(), json!("on"));
        assert!(
            catalog
                .offer(&profile, instance, "accept-edits", &features)
                .is_none()
        );
    }
}
